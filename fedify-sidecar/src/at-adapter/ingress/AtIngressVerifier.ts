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
} from './AtIngressEvents';
import { AtFirehoseDecoder, FirehoseDecodeError } from './AtFirehoseDecoder';
import { AtIngressEventClassifier } from './AtIngressEventClassifier';
import { AtIngressAuditPublisher } from './AtIngressAuditPublisher';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents';

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
  rebuildRepo(did: string): Promise<{
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
  ) {}

  async handleRawEvent(envelope: AtFirehoseRawEnvelope): Promise<boolean> {
    try {
      // 1. Check deduplication
      const isDuplicate = await this.classifier.isDuplicate(envelope.source, envelope.seq);
      if (isDuplicate) {
        await this.publishFailure(envelope, 'dedupe_rejected', { reason: 'already processed' });
        return true; // Handled
      }

      // 2. Decode full payload
      let decoded: any;
      try {
        const frameBytes = Buffer.from(envelope.rawCborBase64, 'base64');
        decoded = this.decoder.decodeFull(frameBytes);
      } catch (err) {
        await this.publishFailure(envelope, 'decode_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }

      const { header, body } = decoded;

      // 3. Extract DID (header takes precedence over body)
      const did = header.did ?? body?.did ?? body?.repo ?? envelope.did;

      // 4. Filter by relevance (Phase 5.5A/B)
      if (did) {
        const isRelevant = await this.classifier.isRelevantDid(did);
        if (!isRelevant) {
          // Irrelevant DIDs are silently dropped, not logged as failures.
          await this.classifier.markProcessed(envelope.source, envelope.seq);
          return true;
        }
      }

      // 5. Route to specific verifier based on event type
      const eventType = header.t || envelope.eventType;

      switch (eventType) {
        case '#commit':
          await this.handleCommit(envelope, did, body);
          break;
        case '#identity':
          await this.handleIdentity(envelope, did);
          break;
        case '#account':
          await this.handleAccount(envelope, did, body);
          break;
        case '#sync':
          await this.handleSync(envelope, did);
          break;
        case '#info':
          // Control frames are silently ignored.
          break;
        default:
          await this.publishFailure(envelope, 'unsupported_event', { eventType });
          break;
      }

      // 6. Mark processed to prevent replay
      await this.classifier.markProcessed(envelope.source, envelope.seq);
      return true;

    } catch (err) {
      console.error(`[AtIngressVerifier] Unhandled error processing seq ${envelope.seq}:`, err);
      // Return false to indicate the message should be retried by the consumer group.
      return false;
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
      await this.publishFailure(envelope, 'signature_invalid', { reason: result.reason });
      return;
    }

    // Emit a trusted event for each operation in the commit
    if (result.ops) {
      for (const op of result.ops) {
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

    const ingressEvent: AtIngressEvent = {
      seq: envelope.seq,
      did,
      eventType: '#account',
      verifiedAt: new Date().toISOString(),
      source: envelope.source,
      account: {
        active,
        status,
      },
    };

    await this.eventPublisher.publish(INGRESS_TOPIC, ingressEvent as any);
  }

  private async handleSync(envelope: AtFirehoseRawEnvelope, did: string | null): Promise<void> {
    if (!did) {
      await this.publishFailure(envelope, 'decode_failed', { reason: 'missing DID in sync event' });
      return;
    }

    // Sync events trigger a full repo rebuild; they are NOT forwarded to ingress.v1
    const result = await this.syncRebuilder.rebuildRepo(did);

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
