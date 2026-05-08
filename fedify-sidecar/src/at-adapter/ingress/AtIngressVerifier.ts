/**
 * V6.5 Phase 5.5: AT Ingress Verifier
 *
 * Standalone service responsible for consuming raw envelopes from
 * at.firehose.raw.v1, fully decoding them, verifying cryptographic and
 * structural integrity, and emitting trusted events to at.ingress.v1.
 *
 * Verification rules (from spec):
 *   - #commit: self-certifying. Requires structural + cryptographic
 *     verification against the DID's signing key.
 *   - #identity: not self-certifying. Requires re-resolving the DID document
 *     and handle from the PLC directory / DNS.
 *   - #account: authoritative for the emitting service's hosting status.
 *   - #sync: repository state assertion. Triggers full repo refetch/rebuild.
 *
 * Failures at any step result in a structured failure event emitted to
 * at.verify-failed.v1, and NO trusted event is emitted.
 *
 * Security notes:
 *   - Events are strictly validated before trust is conferred.
 *   - Invalid signatures or malformed repos result in rejection.
 *   - Deduplication prevents replay attacks or double-processing.
 *
 * Ref: https://atproto.com/specs/event-stream (verification rules)
 */

import {
  AtFirehoseRawEnvelope,
  AtIngressEvent,
  AtVerifyFailedEvent,
} from './AtIngressEvents.js';
import { AtFirehoseDecoder, FirehoseDecodeError } from './AtFirehoseDecoder.js';
import { AtIngressEventClassifier } from './AtIngressEventClassifier.js';
import { AtIngressAuditPublisher } from './AtIngressAuditPublisher.js';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';
import type { SpamEvaluator } from '../../mrf/SpamEvaluator.js';
import { buildEnvelopeFromAT } from '../../mrf/MRFActivityEnvelope.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INGRESS_TOPIC = 'at.ingress.v1';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AtIngressVerifier {
  /**
   * Process a raw envelope.
   * Returns true if processing completed (either success or handled failure).
   * Returns false if the event should be retried (e.g. transient network error).
   */
  handleRawEvent(event: AtFirehoseRawEnvelope): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Dependencies (Mocked for Phase 5.5 boundary)
// ---------------------------------------------------------------------------

export interface AtCommitVerifier {
  verifyCommit(body: any): Promise<{
    isValid: boolean;
    requiresSync?: boolean;
    failureReason?: AtVerifyFailedEvent["reason"];
    reason?: string;
    ops?: Array<{
      action: 'create' | 'update' | 'delete';
      collection: string;
      rkey: string;
      cid: string | null;
      record: Record<string, unknown> | null;
    }>;
  }>;
}

export interface AtIdentityResolver {
  resolveIdentity(did: string): Promise<{
    success: boolean;
    handle?: string;
    didDocument?: Record<string, unknown>;
    reason?: string;
  }>;
}

export interface AtSyncRebuilder {
  rebuildRepo(did: string, options?: { source?: string | null }): Promise<{
    success: boolean;
    reason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtIngressVerifier implements AtIngressVerifier {
  constructor(
    private readonly decoder: AtFirehoseDecoder,
    private readonly classifier: AtIngressEventClassifier,
    private readonly auditPublisher: AtIngressAuditPublisher,
    private readonly eventPublisher: EventPublisher,
    private readonly commitVerifier: AtCommitVerifier,
    private readonly identityResolver: AtIdentityResolver,
    private readonly syncRebuilder: AtSyncRebuilder,
    private readonly spamEvaluator?: SpamEvaluator,
  ) {}

  async handleRawEvent(envelope: AtFirehoseRawEnvelope): Promise<boolean> {
    const t0 = Date.now();
    let tDedup = 0, tDecode = 0, tRelevance = 0, tHandle = 0, tMark = 0;
    let stage = 'start';
    try {
      // 1. Check deduplication
      stage = 'isDuplicate';
      const isDuplicate = await this.classifier.isDuplicate(envelope.source, envelope.seq);
      tDedup = Date.now() - t0;
      if (isDuplicate) {
        await this.publishFailure(envelope, 'dedupe_rejected', { reason: 'already processed' });
        return true; // Handled
      }

      // 2. Decode full payload
      let decoded: any;
      const tDecStart = Date.now();
      try {
        stage = 'decodeFull';
        const frameBytes = Buffer.from(envelope.rawCborBase64, 'base64');
        decoded = this.decoder.decodeFull(frameBytes);
      } catch (err) {
        await this.publishFailure(envelope, 'decode_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
      tDecode = Date.now() - tDecStart;

      const { header, body } = decoded;

      // 3. Extract DID (header takes precedence over body)
      const did = header.did ?? body?.did ?? body?.repo ?? envelope.did;

      // 4. Filter by relevance (Phase 5.5A/B)
      const tRelStart = Date.now();
      if (did) {
        stage = 'isRelevantDid';
        const isRelevant = await this.classifier.isRelevantDid(did);
        if (!isRelevant) {
          // Irrelevant DIDs are silently dropped, not logged as failures.
          await this.classifier.markProcessed(envelope.source, envelope.seq);
          return true;
        }
      }
      tRelevance = Date.now() - tRelStart;

      // 5. Route to specific verifier based on event type
      const eventType = header.t || envelope.eventType;
      const tHandleStart = Date.now();

      switch (eventType) {
        case '#commit':
          stage = 'handleCommit';
          await this.handleCommit(envelope, did, body);
          break;
        case '#identity':
          stage = 'handleIdentity';
          await this.handleIdentity(envelope, did);
          break;
        case '#account':
          stage = 'handleAccount';
          await this.handleAccount(envelope, did, body);
          break;
        case '#sync':
          stage = 'handleSync';
          await this.handleSync(envelope, did);
          break;
        case '#info':
          // Control frames are silently ignored.
          break;
        default:
          await this.publishFailure(envelope, 'unsupported_event', { eventType });
          break;
      }
      tHandle = Date.now() - tHandleStart;
      const tMarkStart = Date.now();
      // Sample slow events
      const total = Date.now() - t0;
      if (total > 200) {
        // eslint-disable-next-line no-console
        console.warn(`[AtIngressVerifier perf] type=${eventType} total=${total}ms dedup=${tDedup} decode=${tDecode} relevance=${tRelevance} handle=${tHandle} did=${did}`);
      }
      tMark = Date.now() - tMarkStart;
      void tMark;

      // 6. Mark processed to prevent replay
      await this.classifier.markProcessed(envelope.source, envelope.seq);
      return true;

    } catch (err) {
      // Poison-pill protection: a synchronous code error (e.g. malformed body,
      // serializer rejecting undefined) must NOT cause infinite consumer retries
      // that pin the partition and crash the consumer group. Record the failure,
      // mark the seq as processed so we advance, and return true.
      console.error(`[AtIngressVerifier] Unhandled error processing seq ${envelope.seq}:`, err);
      try {
        await this.publishFailure(envelope, 'decode_failed', {
          error: err instanceof Error ? err.message : String(err),
          stage: 'handleRawEvent',
        });
      } catch (publishErr) {
        console.error(`[AtIngressVerifier] Failed to publish failure for seq ${envelope.seq}:`, publishErr);
      }
      try {
        await this.classifier.markProcessed(envelope.source, envelope.seq);
      } catch (markErr) {
        console.error(`[AtIngressVerifier] Failed to mark seq ${envelope.seq} processed:`, markErr);
      }
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  private async handleCommit(envelope: AtFirehoseRawEnvelope, did: string | null, body: any): Promise<void> {
    if (!did) {
      await this.publishFailure(envelope, 'decode_failed', { reason: 'missing DID in commit' });
      return;
    }

    // Perform cryptographic and structural verification
    const result = await this.commitVerifier.verifyCommit(body);

    if (!result.isValid) {
      await this.publishFailure(
        envelope,
        result.failureReason ?? 'signature_invalid',
        { reason: result.reason },
      );
      return;
    }

    if (result.requiresSync) {
      const syncResult = await this.syncRebuilder.rebuildRepo(did, {
        source: envelope.source,
      });

      if (!syncResult.success) {
        await this.publishFailure(envelope, 'sync_rebuild_failed', {
          reason: syncResult.reason ?? result.reason ?? 'commit verification requested repo rebuild',
        });
      }
      return;
    }

    // Emit a trusted event for each operation in the commit
    if (result.ops) {
      for (const op of result.ops) {
        // Spam evaluation: only check post creates — deletes/updates are benign.
        if (
          this.spamEvaluator &&
          op.action === 'create' &&
          op.collection === 'app.bsky.feed.post' &&
          op.record
        ) {
          const envelope_ = buildEnvelopeFromAT({
            did,
            collection: op.collection,
            rkey: op.rkey,
            record: op.record,
          });
          if (envelope_) {
            let spamDecision: import('../../mrf/SpamEvaluator.js').SpamDecision | null = null;
            try {
              spamDecision = await this.spamEvaluator.evaluateAt(envelope_);
            } catch (err) {
              // Fail-open: spam check errors must not drop legitimate content.
              console.warn(`[AtIngressVerifier] Spam evaluation error for ${did}/${op.rkey}:`, err);
            }
            if (spamDecision && (spamDecision.appliedAction === 'filter' || spamDecision.appliedAction === 'reject')) {
              console.info(
                `[AtIngressVerifier] AT post suppressed by spam evaluator`,
                { did, rkey: op.rkey, moduleId: spamDecision.moduleId, action: spamDecision.appliedAction },
              );
              continue;
            }
          }
        }

        const ingressEvent: AtIngressEvent = {
          seq: envelope.seq,
          did,
          eventType: '#commit',
          verifiedAt: new Date().toISOString(),
          source: envelope.source,
          commit: {
            rev: body.rev,
            operation: op.action,
            collection: op.collection,
            rkey: op.rkey,
            cid: op.cid,
            record: op.record,
            signatureValid: true,
          },
        };

        await this.eventPublisher.publish(INGRESS_TOPIC, ingressEvent as any);
      }
    }
  }

  private async handleIdentity(envelope: AtFirehoseRawEnvelope, did: string | null): Promise<void> {
    if (!did) {
      await this.publishFailure(envelope, 'decode_failed', { reason: 'missing DID in identity event' });
      return;
    }

    // Identity events are hints; we must re-resolve from authority.
    const result = await this.identityResolver.resolveIdentity(did);

    if (!result.success || !result.didDocument) {
      await this.publishFailure(envelope, 'did_resolution_failed', { reason: result.reason });
      return;
    }

    const ingressEvent: AtIngressEvent = {
      seq: envelope.seq,
      did,
      eventType: '#identity',
      verifiedAt: new Date().toISOString(),
      source: envelope.source,
      identity: {
        handle: result.handle,
        didDocument: result.didDocument,
      },
    };

    await this.eventPublisher.publish(INGRESS_TOPIC, ingressEvent as any);
  }

  private async handleAccount(envelope: AtFirehoseRawEnvelope, did: string | null, body: any): Promise<void> {
    if (!did) {
      await this.publishFailure(envelope, 'decode_failed', { reason: 'missing DID in account event' });
      return;
    }

    const active = body.active === true;
    const status = body.status;

    // Omit `status` when undefined: downstream JSON serializers (SafeJson) reject
    // undefined property values and would turn this record into a poison pill that
    // blocks the partition forever via infinite retries.
    const accountPayload: { active: boolean; status?: unknown } = { active };
    if (status !== undefined) {
      accountPayload.status = status;
    }

    const ingressEvent: AtIngressEvent = {
      seq: envelope.seq,
      did,
      eventType: '#account',
      verifiedAt: new Date().toISOString(),
      source: envelope.source,
      account: accountPayload as AtIngressEvent['account'],
    };

    await this.eventPublisher.publish(INGRESS_TOPIC, ingressEvent as any);
  }

  private async handleSync(envelope: AtFirehoseRawEnvelope, did: string | null): Promise<void> {
    if (!did) {
      await this.publishFailure(envelope, 'decode_failed', { reason: 'missing DID in sync event' });
      return;
    }

    // Sync events trigger a full repo rebuild; they are NOT forwarded to ingress.v1
    const result = await this.syncRebuilder.rebuildRepo(did, {
      source: envelope.source,
    });

    if (!result.success) {
      await this.publishFailure(envelope, 'sync_rebuild_failed', { reason: result.reason });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async publishFailure(
    envelope: AtFirehoseRawEnvelope,
    reason: AtVerifyFailedEvent['reason'],
    details?: Record<string, unknown>,
  ): Promise<void> {
    const failureEvent: AtVerifyFailedEvent = {
      seq: envelope.seq,
      did: envelope.did,
      source: envelope.source,
      eventType: envelope.eventType,
      failedAt: new Date().toISOString(),
      reason,
      details,
    };

    await this.auditPublisher.publishVerifyFailed(failureEvent);
  }
}
