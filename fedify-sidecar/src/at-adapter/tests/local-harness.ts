/**
 * V6.5 Phase 5.5: Local Test Harness
 *
 * This script provides a fully self-contained local environment to test
 * the AT Protocol Ingress Pipeline without requiring an external firehose
 * or a running AmoreTechLllc/memory API.
 *
 * It spins up:
 *   1. A Mock AT Firehose (WebSocket server) that emits valid CBOR frames.
 *   2. The full AtFirehoseConsumer and AtIngressVerifier pipeline.
 *   3. A Mock Webhook Receiver (HTTP server) that acts like the memory UI.
 *
 * Usage:
 *   npx tsx src/at-adapter/tests/local-harness.ts
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import * as crypto from 'crypto';
import { encode } from '@ipld/dag-cbor';

import {
  DefaultAtFirehoseConsumer,
  DefaultAtFirehoseDecoder,
  InMemoryAtFirehoseCursorManager,
  InMemoryAtIngressEventClassifier,
  InMemoryAtIngressAuditPublisher,
  DefaultAtIngressVerifier,
  AtIngressWebhookForwarder,
  AtCommitVerifier,
  AtIdentityResolver,
  AtSyncRebuilder,
} from '../ingress/index.js';

import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_PORT = 8999;
const HTTP_PORT = 8998;
const SECRET = 'local-test-secret-123';
const MOCK_FIREHOSE_URL = `ws://localhost:${WS_PORT}`;
const MOCK_WEBHOOK_URL = `http://localhost:${HTTP_PORT}/at/webhook/ingress`;

// ---------------------------------------------------------------------------
// 1. Mock Webhook Receiver (Simulates memory API)
// ---------------------------------------------------------------------------

function startMockWebhookServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/at/webhook/ingress') {
      const secret = req.headers['x-bridge-secret'];
      if (secret !== SECRET) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const events = JSON.parse(body);
          console.log(`\n[Mock Memory UI] 📥 Received ${events.length} verified events via webhook:`);
          events.forEach((e: any) => {
            console.log(`  → ${e.eventType} from ${e.did} (seq: ${e.seq})`);
            if (e.eventType === '#commit') {
              console.log(`    Content: "${e.commit.record?.text}"`);
            }
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ processed: events.length, failed: 0, total: events.length }));
        } catch (err) {
          res.writeHead(400);
          res.end('Bad Request');
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[Mock Memory UI] Listening on ${MOCK_WEBHOOK_URL}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// 2. Mock AT Firehose (Simulates relay.bsky.network)
// ---------------------------------------------------------------------------

function startMockFirehoseServer() {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on('connection', (ws) => {
    console.log(`[Mock Firehose] 🔌 Client connected`);

    let seq = 1;

    // Send a mock commit event every 2 seconds
    const interval = setInterval(() => {
      const header = { op: 1, t: '#commit' };
      const body = {
        seq: seq++,
        repo: 'did:plc:mockactor123',
        time: new Date().toISOString(),
        commit: { cid: 'bafyreimock' },
        ops: [
          {
            action: 'create',
            path: `app.bsky.feed.post/mockrkey${seq}`,
            cid: 'bafyreimock',
          }
        ],
        blocks: new Uint8Array([0x01, 0x02, 0x03]), // Fake CAR bytes
      };

      // In a real firehose, frames are two concatenated CBOR objects
      // @ipld/dag-cbor does not concatenate well out of the box, we need to encode them separately
      const headerBytes = encode(header);
      const bodyBytes = encode(body);
      const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
      frame.set(headerBytes, 0);
      frame.set(bodyBytes, headerBytes.length);

      console.log(`[Mock Firehose] 📤 Emitting #commit seq ${body.seq}`);
      // Send as binary (node ws sends Uint8Array as binary by default)
      ws.send(frame, { binary: true });
    }, 2000);

    ws.on('close', () => {
      console.log(`[Mock Firehose] 🔌 Client disconnected`);
      clearInterval(interval);
    });
  });

  console.log(`[Mock Firehose] Listening on ${MOCK_FIREHOSE_URL}`);
  return wss;
}

// ---------------------------------------------------------------------------
// 3. The Ingress Pipeline (Simulates mastopod-federation-architecture)
// ---------------------------------------------------------------------------

async function startIngressPipeline() {
  console.log(`[Ingress Pipeline] Booting...`);

  // --- Mocks for dependencies ---

  // 1. Webhook Forwarder
  const forwarder = new AtIngressWebhookForwarder();
  forwarder.registerEndpoint({
    id: 'local-memory-ui',
    url: MOCK_WEBHOOK_URL,
    secret: SECRET,
  });

  // 2. Event Publisher (simulates RedPanda)
  const mockEventPublisher: EventPublisher = {
    publish: async (topic, event) => {
      if (topic === 'at.ingress.v1') {
        console.log(`[Ingress Pipeline] ✅ Verified event published to ${topic}`);
        // Immediately forward to webhook
        await forwarder.forwardBatch([event as any]);
      } else if (topic === 'at.firehose.raw.v1') {
        console.log(`[Ingress Pipeline] 📥 Raw event published to ${topic}`);
        // Immediately pass to verifier
        try {
          const success = await verifier.handleRawEvent(event as any);
          if (!success) {
             console.error('[Ingress Pipeline] Verifier returned false (retry needed)');
          }
        } catch (err) {
          console.error('[Ingress Pipeline] Verifier error:', err);
        }
      }
    },
    publishBatch: async () => {},
  };

  // 3. Verifier dependencies
  const mockCommitVerifier = {
    verifyCommit: async (body: any) => {
      console.log(`[Ingress Pipeline] 🔍 Verifying commit...`);
      return {
        isValid: true,
        ops: [{
          action: 'create' as const,
          collection: 'app.bsky.feed.post',
          rkey: 'mockrkey' + Date.now(),
          cid: 'bafyreimock',
          record: {
            $type: 'app.bsky.feed.post',
            text: 'Hello from the local test harness! 🚀',
            createdAt: new Date().toISOString(),
          }
        }]
      };
    }
  };

  const mockIdentityResolver = {
    resolveIdentity: async () => ({
      success: true,
      handle: 'mockactor.bsky.social',
      didDocument: { id: 'did:plc:mockactor123' }
    })
  };

  const mockSyncRebuilder = {
    rebuildRepo: async () => ({ success: true })
  };

  // --- Pipeline Construction ---

  const decoder = new DefaultAtFirehoseDecoder();
  const cursorManager = new InMemoryAtFirehoseCursorManager();
  
  // Phase 5.5B Allowlist Classifier
  const classifier = new InMemoryAtIngressEventClassifier({
    acceptAll: true, // Allow all for local test harness
    allowedDids: ['did:plc:mockactor123']
  });
  
  const auditPublisher = new InMemoryAtIngressAuditPublisher();

  const verifier = new DefaultAtIngressVerifier(
    decoder,
    classifier,
    auditPublisher,
    mockEventPublisher,
    mockCommitVerifier,
    mockIdentityResolver,
    mockSyncRebuilder
  );

  const consumer = new DefaultAtFirehoseConsumer(
    decoder,
    cursorManager,
    mockEventPublisher
  );

  // Start consuming
  console.log(`[Ingress Pipeline] Connecting to ${MOCK_FIREHOSE_URL}...`);
  await consumer.start({
    id: 'local-mock',
    url: MOCK_FIREHOSE_URL,
    sourceType: 'relay'
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log('====================================================');
  console.log('  V6.5 Phase 5.5: AT Ingress Pipeline Local Harness ');
  console.log('====================================================\n');

  const webhookServer = startMockWebhookServer();
  const firehoseServer = startMockFirehoseServer();

  // Give servers a moment to bind
  await new Promise(r => setTimeout(r, 500));

  await startIngressPipeline();

  // Run for 10 seconds then shut down
  setTimeout(() => {
    console.log('\n[Harness] Test complete, shutting down...');
    firehoseServer.close();
    webhookServer.close();
    process.exit(0);
  }, 10000);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
