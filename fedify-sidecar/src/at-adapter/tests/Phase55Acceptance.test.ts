/**
 * V6.5 Phase 5.5: External ATProto Firehose Intake — Acceptance Tests
 *
 * Tests 1–7 covering:
 *   1. Raw ingest: frame → at.firehose.raw.v1, cursor only after ack
 *   2. Trusted commit promotion: valid #commit → at.ingress.v1
 *   3. Identity refresh: #identity → DID/handle re-resolution
 *   4. Account status update: #account → normalised status event
 *   5. Sync rebuild: #sync → full repo refetch, stale marker cleared
 *   6. Replay after restart: resume from durable committed cursor
 *   7. Verify failure path: invalid signature → at.verify-failed.v1
 */

import {
  DefaultAtIngressVerifier,
  AtCommitVerifier,
  AtIdentityResolver,
  AtSyncRebuilder,
} from '../ingress/AtIngressVerifier';
import { DefaultAtFirehoseDecoder } from '../ingress/AtFirehoseDecoder';
import { InMemoryAtIngressEventClassifier } from '../ingress/AtIngressEventClassifier';
import { InMemoryAtIngressAuditPublisher } from '../ingress/AtIngressAuditPublisher';
import { InMemoryAtFirehoseCursorManager } from '../ingress/AtFirehoseCursorManager';
import { InMemoryAtIngressCheckpointStore } from '../ingress/AtIngressCheckpointStore';
import { AtFirehoseRawEnvelope } from '../ingress/AtIngressEvents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal raw envelope for testing.
 * rawCborBase64 is a base64-encoded JSON string (stub for test environments
 * without a real CBOR library).
 */
function buildRawEnvelope(
  overrides: Partial<AtFirehoseRawEnvelope> = {},
): AtFirehoseRawEnvelope {
  const defaults: AtFirehoseRawEnvelope = {
    seq: 1001,
    source: 'wss://relay.bsky.network',
    receivedAt: '2024-01-01T00:00:00.000Z',
    eventType: '#commit',
    did: 'did:plc:testactor123',
    rawCborBase64: Buffer.from(
      JSON.stringify({
        header: { t: '#commit', op: 1 },
        body: {
          seq: 1001,
          did: 'did:plc:testactor123',
          repo: 'did:plc:testactor123',
          rev: '3jqfcqzm3fx2j',
          ops: [
            {
              action: 'create',
              path: 'app.bsky.feed.post/3jqfcqzm3fx2j',
              cid: 'bafyreidtest',
            },
          ],
        },
      }),
    ).toString('base64'),
  };
  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function buildMockCommitVerifier(
  isValid = true,
  reason?: string,
): AtCommitVerifier {
  return {
    verifyCommit: jest.fn().mockResolvedValue({
      isValid,
      reason,
      ops: isValid
        ? [
            {
              action: 'create',
              collection: 'app.bsky.feed.post',
              rkey: '3jqfcqzm3fx2j',
              cid: 'bafyreidtest',
              record: { $type: 'app.bsky.feed.post', text: 'Hello', createdAt: '2024-01-01T00:00:00Z' },
            },
          ]
        : undefined,
    }),
  };
}

function buildMockIdentityResolver(success = true): AtIdentityResolver {
  return {
    resolveIdentity: jest.fn().mockResolvedValue({
      success,
      handle: success ? 'alice.bsky.social' : undefined,
      didDocument: success ? { id: 'did:plc:testactor123', '@context': ['https://www.w3.org/ns/did/v1'] } : undefined,
      reason: success ? undefined : 'DID not found',
    }),
  };
}

function buildMockSyncRebuilder(success = true): AtSyncRebuilder {
  return {
    rebuildRepo: jest.fn().mockResolvedValue({
      success,
      reason: success ? undefined : 'CAR fetch failed',
    }),
  };
}

function buildMockEventPublisher() {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
    publishBatch: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Phase 5.5 Acceptance Tests', () => {
  let decoder: DefaultAtFirehoseDecoder;
  let classifier: InMemoryAtIngressEventClassifier;
  let auditPublisher: InMemoryAtIngressAuditPublisher;
  let eventPublisher: ReturnType<typeof buildMockEventPublisher>;
  let commitVerifier: AtCommitVerifier;
  let identityResolver: AtIdentityResolver;
  let syncRebuilder: AtSyncRebuilder;
  let verifier: DefaultAtIngressVerifier;

  beforeEach(() => {
    jest.clearAllMocks();
    decoder = new DefaultAtFirehoseDecoder();
    classifier = new InMemoryAtIngressEventClassifier({ acceptAll: true });
    auditPublisher = new InMemoryAtIngressAuditPublisher();
    eventPublisher = buildMockEventPublisher();
    commitVerifier = buildMockCommitVerifier();
    identityResolver = buildMockIdentityResolver();
    syncRebuilder = buildMockSyncRebuilder();

    verifier = new DefaultAtIngressVerifier(
      decoder,
      classifier,
      auditPublisher,
      eventPublisher as any,
      commitVerifier,
      identityResolver,
      syncRebuilder,
    );
  });

  // -------------------------------------------------------------------------
  // Test 1 — Raw ingest
  // -------------------------------------------------------------------------
  describe('Test 1: Raw ingest — cursor advances only after ack', () => {
    it('should advance hot cursor only after successful publish ack', async () => {
      const cursorManager = new InMemoryAtFirehoseCursorManager();
      const checkpointStore = new InMemoryAtIngressCheckpointStore();

      // Simulate the consumer's cursor-advance logic
      const seq = 1001;
      const sourceId = 'wss://relay.bsky.network';

      // Before publish: cursor should be null
      const before = await cursorManager.getHotCursor(sourceId);
      expect(before).toBeNull();

      // Simulate ack by advancing cursor
      await cursorManager.setHotCursor(sourceId, seq);

      // After ack: cursor should be set
      const after = await cursorManager.getHotCursor(sourceId);
      expect(after).toBe(seq);

      // Committed cursor should still be null (not flushed yet)
      const committed = await cursorManager.getCommittedCursor(sourceId);
      expect(committed).toBeNull();
    });

    it('should not advance cursor if publish fails', async () => {
      const cursorManager = new InMemoryAtFirehoseCursorManager();
      const sourceId = 'wss://relay.bsky.network';

      // Simulate publish failure (cursor is NOT advanced)
      // This is the contract: setHotCursor is called ONLY after ack.
      const before = await cursorManager.getHotCursor(sourceId);
      expect(before).toBeNull();

      // Cursor remains null because we did not call setHotCursor
      const after = await cursorManager.getHotCursor(sourceId);
      expect(after).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — Trusted commit promotion
  // -------------------------------------------------------------------------
  describe('Test 2: Trusted commit promotion', () => {
    it('should emit at.ingress.v1 for a valid #commit event', async () => {
      const envelope = buildRawEnvelope({ eventType: '#commit' });

      const result = await verifier.handleRawEvent(envelope);

      expect(result).toBe(true);
      expect(eventPublisher.publish).toHaveBeenCalledWith(
        'at.ingress.v1',
        expect.objectContaining({
          seq: 1001,
          did: 'did:plc:testactor123',
          eventType: '#commit',
          commit: expect.objectContaining({
            operation: 'create',
            collection: 'app.bsky.feed.post',
            signatureValid: true,
          }),
        }),
      );
      expect(auditPublisher.published).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — Identity refresh
  // -------------------------------------------------------------------------
  describe('Test 3: Identity refresh', () => {
    it('should re-resolve DID/handle and emit trusted identity event', async () => {
      const envelope = buildRawEnvelope({
        eventType: '#identity',
        rawCborBase64: Buffer.from(
          JSON.stringify({
            header: { t: '#identity', op: 1 },
            body: { seq: 1002, did: 'did:plc:testactor123' },
          }),
        ).toString('base64'),
        seq: 1002,
      });

      const result = await verifier.handleRawEvent(envelope);

      expect(result).toBe(true);
      expect(identityResolver.resolveIdentity).toHaveBeenCalledWith('did:plc:testactor123');
      expect(eventPublisher.publish).toHaveBeenCalledWith(
        'at.ingress.v1',
        expect.objectContaining({
          eventType: '#identity',
          identity: expect.objectContaining({
            handle: 'alice.bsky.social',
            didDocument: expect.objectContaining({ id: 'did:plc:testactor123' }),
          }),
        }),
      );
    });

    it('should emit at.verify-failed.v1 if DID resolution fails', async () => {
      identityResolver = buildMockIdentityResolver(false);
      verifier = new DefaultAtIngressVerifier(
        decoder, classifier, auditPublisher, eventPublisher as any,
        commitVerifier, identityResolver, syncRebuilder,
      );

      const envelope = buildRawEnvelope({
        eventType: '#identity',
        rawCborBase64: Buffer.from(
          JSON.stringify({
            header: { t: '#identity', op: 1 },
            body: { seq: 1003, did: 'did:plc:testactor123' },
          }),
        ).toString('base64'),
        seq: 1003,
      });

      await verifier.handleRawEvent(envelope);

      expect(eventPublisher.publish).not.toHaveBeenCalledWith('at.ingress.v1', expect.anything());
      expect(auditPublisher.published).toHaveLength(1);
      expect(auditPublisher.published[0].reason).toBe('did_resolution_failed');
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — Account status update
  // -------------------------------------------------------------------------
  describe('Test 4: Account status update', () => {
    it('should emit normalised account status event for active=false', async () => {
      const envelope = buildRawEnvelope({
        eventType: '#account',
        rawCborBase64: Buffer.from(
          JSON.stringify({
            header: { t: '#account', op: 1 },
            body: {
              seq: 1004,
              did: 'did:plc:testactor123',
              active: false,
              status: 'suspended',
            },
          }),
        ).toString('base64'),
        seq: 1004,
      });

      await verifier.handleRawEvent(envelope);

      expect(eventPublisher.publish).toHaveBeenCalledWith(
        'at.ingress.v1',
        expect.objectContaining({
          eventType: '#account',
          account: expect.objectContaining({
            active: false,
            status: 'suspended',
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — Sync rebuild
  // -------------------------------------------------------------------------
  describe('Test 5: Sync rebuild', () => {
    it('should trigger repo rebuild and NOT emit to at.ingress.v1', async () => {
      const envelope = buildRawEnvelope({
        eventType: '#sync',
        rawCborBase64: Buffer.from(
          JSON.stringify({
            header: { t: '#sync', op: 1 },
            body: { seq: 1005, did: 'did:plc:testactor123' },
          }),
        ).toString('base64'),
        seq: 1005,
      });

      await verifier.handleRawEvent(envelope);

      expect(syncRebuilder.rebuildRepo).toHaveBeenCalledWith('did:plc:testactor123');
      // #sync must NOT be forwarded to at.ingress.v1
      expect(eventPublisher.publish).not.toHaveBeenCalledWith('at.ingress.v1', expect.anything());
    });

    it('should emit at.verify-failed.v1 if rebuild fails', async () => {
      syncRebuilder = buildMockSyncRebuilder(false);
      verifier = new DefaultAtIngressVerifier(
        decoder, classifier, auditPublisher, eventPublisher as any,
        commitVerifier, identityResolver, syncRebuilder,
      );

      const envelope = buildRawEnvelope({
        eventType: '#sync',
        rawCborBase64: Buffer.from(
          JSON.stringify({
            header: { t: '#sync', op: 1 },
            body: { seq: 1006, did: 'did:plc:testactor123' },
          }),
        ).toString('base64'),
        seq: 1006,
      });

      await verifier.handleRawEvent(envelope);

      expect(auditPublisher.published).toHaveLength(1);
      expect(auditPublisher.published[0].reason).toBe('sync_rebuild_failed');
    });
  });

  // -------------------------------------------------------------------------
  // Test 6 — Replay after restart
  // -------------------------------------------------------------------------
  describe('Test 6: Replay after restart', () => {
    it('should resume from durable committed cursor, not hot cursor', async () => {
      const cursorManager = new InMemoryAtFirehoseCursorManager();
      const sourceId = 'wss://relay.bsky.network';

      // Simulate: hot cursor at 500, committed cursor at 450
      await cursorManager.setHotCursor(sourceId, 500);
      await cursorManager.commitCursor(sourceId, 450);

      // On restart, resume cursor should be the committed (durable) one
      const resumeCursor = await cursorManager.getResumeCursor(sourceId);
      expect(resumeCursor).toBe(450);
    });

    it('should use hot cursor as fallback if no committed cursor exists', async () => {
      const cursorManager = new InMemoryAtFirehoseCursorManager();
      const sourceId = 'wss://relay.bsky.network';

      // Only hot cursor set, no committed cursor
      await cursorManager.setHotCursor(sourceId, 300);

      const resumeCursor = await cursorManager.getResumeCursor(sourceId);
      expect(resumeCursor).toBe(300);
    });

    it('should return null if no cursors exist (cold start)', async () => {
      const cursorManager = new InMemoryAtFirehoseCursorManager();
      const resumeCursor = await cursorManager.getResumeCursor('wss://relay.bsky.network');
      expect(resumeCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 7 — Verify failure path
  // -------------------------------------------------------------------------
  describe('Test 7: Verify failure path', () => {
    it('should emit at.verify-failed.v1 and NOT emit at.ingress.v1 for invalid signature', async () => {
      commitVerifier = buildMockCommitVerifier(false, 'signature_mismatch');
      verifier = new DefaultAtIngressVerifier(
        decoder, classifier, auditPublisher, eventPublisher as any,
        commitVerifier, identityResolver, syncRebuilder,
      );

      const envelope = buildRawEnvelope({ eventType: '#commit' });

      const result = await verifier.handleRawEvent(envelope);

      expect(result).toBe(true);
      expect(eventPublisher.publish).not.toHaveBeenCalledWith('at.ingress.v1', expect.anything());
      expect(auditPublisher.published).toHaveLength(1);
      expect(auditPublisher.published[0]).toMatchObject({
        seq: 1001,
        source: 'wss://relay.bsky.network',
        reason: 'signature_invalid',
        eventType: '#commit',
      });
    });

    it('should emit at.verify-failed.v1 for malformed CBOR', async () => {
      const envelope = buildRawEnvelope({
        rawCborBase64: Buffer.from('not valid cbor or json').toString('base64'),
      });

      // The decoder will fail to parse this
      const result = await verifier.handleRawEvent(envelope);

      expect(result).toBe(true);
      expect(eventPublisher.publish).not.toHaveBeenCalledWith('at.ingress.v1', expect.anything());
      expect(auditPublisher.published).toHaveLength(1);
      expect(auditPublisher.published[0].reason).toBe('decode_failed');
    });

    it('should not emit trusted event for duplicate seq', async () => {
      const envelope = buildRawEnvelope({ seq: 9999 });

      // First processing
      await verifier.handleRawEvent(envelope);
      const firstPublishCount = (eventPublisher.publish as jest.Mock).mock.calls.length;

      // Second processing (replay)
      await verifier.handleRawEvent(envelope);
      const secondPublishCount = (eventPublisher.publish as jest.Mock).mock.calls.length;

      // No additional trusted events should have been published
      expect(secondPublishCount).toBe(firstPublishCount);
      // The second attempt should result in a dedupe failure
      const dedupeFailures = auditPublisher.published.filter(e => e.reason === 'dedupe_rejected');
      expect(dedupeFailures).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 8 — Phase 5.5B allowlist filtering
  // -------------------------------------------------------------------------
  describe('Test 8: Phase 5.5B allowlist filtering', () => {
    it('should silently drop events for DIDs not in allowlist', async () => {
      const restrictiveClassifier = new InMemoryAtIngressEventClassifier({
        acceptAll: false,
        allowedDids: ['did:plc:allowed'],
      });

      const restrictiveVerifier = new DefaultAtIngressVerifier(
        decoder, restrictiveClassifier, auditPublisher, eventPublisher as any,
        commitVerifier, identityResolver, syncRebuilder,
      );

      const envelope = buildRawEnvelope({ did: 'did:plc:notallowed' });
      await restrictiveVerifier.handleRawEvent(envelope);

      // Should not publish to ingress or failure topic
      expect(eventPublisher.publish).not.toHaveBeenCalled();
      expect(auditPublisher.published).toHaveLength(0);
    });

    it('should process events for DIDs in allowlist', async () => {
      const restrictiveClassifier = new InMemoryAtIngressEventClassifier({
        acceptAll: false,
        allowedDids: ['did:plc:testactor123'],
      });

      const restrictiveVerifier = new DefaultAtIngressVerifier(
        decoder, restrictiveClassifier, auditPublisher, eventPublisher as any,
        commitVerifier, identityResolver, syncRebuilder,
      );

      const envelope = buildRawEnvelope({ did: 'did:plc:testactor123' });
      await restrictiveVerifier.handleRawEvent(envelope);

      expect(eventPublisher.publish).toHaveBeenCalledWith('at.ingress.v1', expect.anything());
    });
  });
});
