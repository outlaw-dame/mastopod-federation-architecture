/**
 * V6.5 Phase 5.5: Docker-Aware Local Harness
 *
 * This is the Docker variant of the local test harness. It reads the
 * Memory API webhook URL and bridge secret from environment variables,
 * allowing it to run inside a Docker container alongside the Memory app.
 *
 * Environment variables:
 *   MEMORY_WEBHOOK_URL     — e.g. http://api:8794/at/webhook/ingress
 *   FIREHOSE_BRIDGE_SECRET — shared HMAC secret
 *   USE_REAL_FIREHOSE      — 'true' to connect to relay.bsky.network
 *
 * Usage (via docker-compose):
 *   docker compose -f docker-compose.local.yml up --build
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { encode } from '@ipld/dag-cbor';

import {
  DefaultAtFirehoseConsumer,
  DefaultAtFirehoseDecoder,
  InMemoryAtFirehoseCursorManager,
  InMemoryAtIngressEventClassifier,
  InMemoryAtIngressAuditPublisher,
  DefaultAtIngressVerifier,
  AtIngressWebhookForwarder,
} from '../ingress/index.js';

import type { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const WEBHOOK_URL = process.env["MEMORY_WEBHOOK_URL"] || 'http://localhost:8794/at/webhook/ingress';
const SECRET = process.env["FIREHOSE_BRIDGE_SECRET"] || 'local-bridge-secret-123';
const USE_REAL_FIREHOSE = process.env["USE_REAL_FIREHOSE"] === 'true';
const MOCK_WS_PORT = 8999;
const MOCK_FIREHOSE_URL = `ws://localhost:${MOCK_WS_PORT}`;
const REAL_FIREHOSE_URL = 'wss://relay.bsky.network';

console.log('====================================================');
console.log('  V6.5 Phase 5.5: AT Ingress Pipeline (Docker Mode) ');
console.log('====================================================');
console.log(`  Webhook URL:    ${WEBHOOK_URL}`);
console.log(`  Firehose mode:  ${USE_REAL_FIREHOSE ? 'REAL (relay.bsky.network)' : 'MOCK (local)'}`);
console.log('====================================================\n');

// ---------------------------------------------------------------------------
// Mock AT Firehose (only used when USE_REAL_FIREHOSE=false)
// ---------------------------------------------------------------------------

function startMockFirehoseServer(): Promise<void> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: MOCK_WS_PORT });
    wss.on('listening', () => {
      console.log(`[Mock Firehose] Listening on ws://localhost:${MOCK_WS_PORT}`);
      resolve();
    });

    wss.on('connection', (ws) => {
      console.log('[Mock Firehose] 🔌 Client connected');
      let seq = 1;

      const interval = setInterval(() => {
        const currentSeq = seq++;
        const header = { op: 1, t: '#commit' };
        const body = {
          seq: currentSeq,
          repo: 'did:plc:mockactor123',
          time: new Date().toISOString(),
          commit: { cid: 'bafyreimock' },
          ops: [{ action: 'create', path: `app.bsky.feed.post/mockrkey${currentSeq}`, cid: 'bafyreimock' }],
          blocks: new Uint8Array([0x01, 0x02, 0x03]),
        };

        const headerBytes = encode(header);
        const bodyBytes = encode(body);
        const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
        frame.set(headerBytes, 0);
        frame.set(bodyBytes, headerBytes.length);

        console.log(`[Mock Firehose] 📤 Emitting #commit seq ${currentSeq}`);
        ws.send(frame, { binary: true });
      }, 3000); // Every 3 seconds

      ws.on('close', () => {
        console.log('[Mock Firehose] 🔌 Client disconnected');
        clearInterval(interval);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Wait for Memory API to be ready
// ---------------------------------------------------------------------------

async function waitForApi(url: string, maxAttempts = 30): Promise<void> {
  const healthUrl = url.replace('/at/webhook/ingress', '/health');
  console.log(`[Harness] Waiting for Memory API at ${healthUrl}...`);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log('[Harness] ✅ Memory API is ready');
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 2000));
    console.log(`[Harness] Waiting... (${i + 1}/${maxAttempts})`);
  }

  console.warn('[Harness] ⚠️  Memory API did not respond in time. Continuing anyway...');
}

// ---------------------------------------------------------------------------
// Ingress Pipeline
// ---------------------------------------------------------------------------

async function startIngressPipeline(firehoseUrl: string): Promise<void> {
  console.log('[Ingress Pipeline] Booting...');

  // Webhook forwarder → Memory API
  const forwarder = new AtIngressWebhookForwarder();
  forwarder.registerEndpoint({
    id: 'memory-api',
    url: WEBHOOK_URL,
    secret: SECRET,
  });

  // Mock commit verifier (Phase 5.5 boundary — real verification in Phase 6)
  const mockCommitVerifier = {
    verifyCommit: async (_body: any) => ({
      isValid: true,
      ops: [{
        action: 'create' as const,
        collection: 'app.bsky.feed.post',
        rkey: `mockrkey${Date.now()}`,
        cid: 'bafyreimock',
        record: {
          $type: 'app.bsky.feed.post',
          text: USE_REAL_FIREHOSE
            ? '(Real Bluesky post — content decoded from firehose)'
            : `Hello from the AT Protocol ingress pipeline! 🚀 [${new Date().toLocaleTimeString()}]`,
          createdAt: new Date().toISOString(),
        },
      }],
    }),
  };

  const mockIdentityResolver = {
    resolveIdentity: async (did: string) => ({
      success: true,
      handle: USE_REAL_FIREHOSE ? `${did.slice(-8)}.bsky.social` : 'mockactor.bsky.social',
      didDocument: { id: did },
    }),
  };

  const mockSyncRebuilder = {
    rebuildRepo: async (_did: string) => ({ success: true }),
  };

  const decoder = new DefaultAtFirehoseDecoder();
  const cursorManager = new InMemoryAtFirehoseCursorManager();
  const classifier = new InMemoryAtIngressEventClassifier({ acceptAll: true, allowedDids: [] });
  const auditPublisher = new InMemoryAtIngressAuditPublisher();

  // Event publisher — bridges raw.v1 → verifier → ingress.v1 → webhook
  let verifier: ReturnType<typeof buildVerifier>;

  function buildVerifier() {
    return new DefaultAtIngressVerifier(
      decoder, classifier, auditPublisher,
      {
        publish: async (topic: string, event: any) => {
          if (topic === 'at.ingress.v1') {
            console.log(`[Ingress Pipeline] ✅ Verified #${event.eventType} from ${event.did}`);
            try {
              const results = await forwarder.forwardBatch([event]);
              const success = results.filter(r => r.success).length;
              const failed = results.filter(r => !r.success).length;
              if (success > 0) console.log(`[Ingress Pipeline] 📨 Forwarded to Memory API (${success} ok, ${failed} failed)`);
            } catch (err) {
              console.error('[Ingress Pipeline] Webhook forward error:', err);
            }
          }
        },
        publishBatch: async () => {},
      } as EventPublisher,
      mockCommitVerifier,
      mockIdentityResolver,
      mockSyncRebuilder,
    );
  }

  verifier = buildVerifier();

  const rawPublisher: EventPublisher = {
    publish: async (topic: string, event: any) => {
      if (topic === 'at.firehose.raw.v1') {
        try {
          await verifier.handleRawEvent(event);
        } catch (err) {
          console.error('[Ingress Pipeline] Verifier error:', err);
        }
      }
    },
    publishBatch: async () => {},
  };

  const consumer = new DefaultAtFirehoseConsumer(decoder, cursorManager, rawPublisher);

  console.log(`[Ingress Pipeline] Connecting to ${firehoseUrl}...`);
  await consumer.start({
    id: USE_REAL_FIREHOSE ? 'relay-bsky-network' : 'local-mock',
    url: firehoseUrl,
    sourceType: 'relay',
  });

  console.log('[Ingress Pipeline] ✅ Running. Events will appear here as they are processed.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let firehoseUrl: string;

  if (USE_REAL_FIREHOSE) {
    firehoseUrl = REAL_FIREHOSE_URL;
    console.log('[Harness] Using REAL AT Firehose (relay.bsky.network)');
  } else {
    await startMockFirehoseServer();
    firehoseUrl = MOCK_FIREHOSE_URL;
    console.log('[Harness] Using MOCK firehose');
  }

  // Wait for the Memory API to be ready before starting
  await waitForApi(WEBHOOK_URL);

  // Give a brief moment for everything to settle
  await new Promise(r => setTimeout(r, 1000));

  await startIngressPipeline(firehoseUrl);

  // Keep running until killed
  process.on('SIGTERM', () => {
    console.log('\n[Harness] Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    console.log('\n[Harness] Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[Harness] Fatal error:', err);
  process.exit(1);
});
