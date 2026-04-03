/**
 * V6.5 Phase 5.5: AT Firehose Consumer
 *
 * Standalone service responsible for connecting to external ATProto firehoses,
 * consuming CBOR frames, and publishing raw envelopes to RedPanda.
 *
 * Architecture:
 *   - Maintains a persistent WebSocket connection to the upstream relay/PDS.
 *   - Resumes from the durable committed cursor on startup.
 *   - Uses AtFirehoseDecoder to classify frames cheaply (header only).
 *   - Publishes the raw CBOR envelope to at.firehose.raw.v1.
 *   - Advances the hot cursor in Redis ONLY after the RedPanda ack.
 *
 * Resilience & Backoff:
 *   - Implements exponential backoff with jitter for WebSocket reconnects.
 *   - Handles ping/pong and connection timeouts.
 *   - Rate-limits periodic cursor commits to the durable store.
 *
 * Security:
 *   - Validates all source URLs before connecting.
 *   - Enforces a maximum frame size to prevent memory exhaustion (OOM).
 *   - Fails safe (reconnects) on unhandled errors rather than crashing the process.
 */

import { WebSocket } from 'ws';
import { AtFirehoseDecoder, FirehoseDecodeError } from './AtFirehoseDecoder.js';
import { AtFirehoseCursorManager } from './AtFirehoseCursorManager.js';
import { AtFirehoseRawEnvelope } from './AtIngressEvents.js';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------

const RAW_FIREHOSE_TOPIC = 'at.firehose.raw.v1';

/** Maximum allowed size for a single CBOR frame (5MB). Prevents OOM. */
const MAX_FRAME_SIZE_BYTES = 5 * 1024 * 1024;

/** Interval to flush the hot cursor to the durable store. */
const CURSOR_COMMIT_INTERVAL_MS = 10_000;

/** WebSocket ping interval to detect dead connections. */
const WS_PING_INTERVAL_MS = 30_000;

/** Maximum time to wait for a pong before terminating the connection. */
const WS_PONG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AtFirehoseSource {
  id: string;
  url: string;
  sourceType: 'relay' | 'pds';
}

export interface AtFirehoseConsumer {
  /**
   * Start consuming from the specified source.
   * Returns immediately after initiating the connection loop.
   */
  start(source: AtFirehoseSource): Promise<void>;

  /**
   * Stop consuming and cleanly shut down the connection.
   */
  stop(sourceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtFirehoseConsumer implements AtFirehoseConsumer {
  private readonly activeConnections = new Map<string, FirehoseConnection>();

  constructor(
    private readonly decoder: AtFirehoseDecoder,
    private readonly cursorManager: AtFirehoseCursorManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async start(source: AtFirehoseSource): Promise<void> {
    if (this.activeConnections.has(source.id)) {
      throw new Error(`Consumer for source ${source.id} is already running`);
    }

    validateSourceUrl(source.url);

    const connection = new FirehoseConnection(
      source,
      this.decoder,
      this.cursorManager,
      this.eventPublisher,
    );

    this.activeConnections.set(source.id, connection);
    
    // Fire and forget the connection loop
    connection.startLoop().catch((err) => {
      console.error(`[AtFirehoseConsumer] Fatal error in connection loop for ${source.id}:`, err);
    });
  }

  async stop(sourceId: string): Promise<void> {
    const connection = this.activeConnections.get(sourceId);
    if (!connection) {
      return;
    }

    await connection.stop();
    this.activeConnections.delete(sourceId);
  }
}

// ---------------------------------------------------------------------------
// Connection Loop Management
// ---------------------------------------------------------------------------

class FirehoseConnection {
  private ws: WebSocket | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private pingInterval: NodeJS.Timeout | null = null;
  private pongTimeout: NodeJS.Timeout | null = null;
  private commitInterval: NodeJS.Timeout | null = null;
  private lastAckedSeq: number | null = null;

  constructor(
    private readonly source: AtFirehoseSource,
    private readonly decoder: AtFirehoseDecoder,
    private readonly cursorManager: AtFirehoseCursorManager,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async startLoop(): Promise<void> {
    this.isRunning = true;

    // Start the periodic cursor commit loop
    this.commitInterval = setInterval(() => {
      this.commitCursorSafely();
    }, CURSOR_COMMIT_INTERVAL_MS);

    while (this.isRunning) {
      try {
        await this.connectAndWait();
        // If connectAndWait returns normally, it means the socket closed cleanly.
        // We reset reconnect attempts and loop around to reconnect.
        this.reconnectAttempts = 0;
      } catch (err) {
        if (!this.isRunning) break;

        this.reconnectAttempts++;
        const delay = this.calculateBackoff();
        
        console.error(
          `[FirehoseConnection] Connection to ${this.source.id} failed. ` +
          `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}). Error:`,
          err instanceof Error ? err.message : String(err),
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.cleanupTimers();

    if (this.ws) {
      this.ws.close(1000, 'Consumer shutting down');
      this.ws = null;
    }

    // Perform a final synchronous flush of the cursor
    await this.commitCursorSafely();
  }

  private async connectAndWait(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // 1. Load resume cursor (prefers durable over hot)
        const cursor = await this.cursorManager.getResumeCursor(this.source.id);
        
        // 2. Construct WebSocket URL
        const url = new URL(this.source.url);
        if (url.pathname === '/') {
          url.pathname = '/xrpc/com.atproto.sync.subscribeRepos';
        }
        if (cursor !== null) {
          url.searchParams.set('cursor', cursor.toString());
        }

        console.log(`[FirehoseConnection] Connecting to ${this.source.id} at ${url.toString()}`);

        // 3. Connect
        this.ws = new WebSocket(url.toString(), {
          maxPayload: MAX_FRAME_SIZE_BYTES,
        });

        this.ws.on('open', () => {
          console.log(`[FirehoseConnection] Connected to ${this.source.id}`);
          this.reconnectAttempts = 0;
          this.setupPingPong();
        });

        this.ws.on('message', async (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            console.warn(`[FirehoseConnection] Received non-binary frame from ${this.source.id}`);
            return;
          }
          await this.handleFrame(new Uint8Array(data));
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[FirehoseConnection] Closed connection to ${this.source.id}: ${code} ${reason}`);
          this.cleanupTimers();
          resolve();
        });

        this.ws.on('error', (err) => {
          this.cleanupTimers();
          reject(err);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    try {
      // 1. Decode header cheaply
      const header = this.decoder.decodeHeader(frame);

      // 2. Build raw envelope
      const envelope: AtFirehoseRawEnvelope = {
        seq: header.seq,
        source: this.source.url,
        receivedAt: new Date().toISOString(),
        eventType: header.eventType,
        did: header.did,
        // Convert the raw bytes to base64 for safe transport via JSON
        rawCborBase64: Buffer.from(frame).toString('base64'),
      };

      // 3. Publish to RedPanda (wait for ack)
      await this.eventPublisher.publish(RAW_FIREHOSE_TOPIC, envelope as any);

      // 4. Only after ack, advance the hot cursor
      if (header.seq >= 0) {
        await this.cursorManager.setHotCursor(this.source.id, header.seq);
        this.lastAckedSeq = header.seq;
      }

    } catch (err) {
      if (err instanceof FirehoseDecodeError) {
        // Invalid firehose framing is a connection-level error per spec.
        // Tear down the socket so we replay from the last acked cursor.
        console.error(`[FirehoseConnection] Invalid frame from ${this.source.id}; reconnecting:`, err.message);
        this.ws?.terminate();
      } else {
        // Publish failures or Redis failures.
        // We throw here to force a reconnect and replay from the last acked cursor.
        console.error(`[FirehoseConnection] Fatal error handling frame from ${this.source.id}:`, err);
        this.ws?.terminate();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle & Timers
  // -------------------------------------------------------------------------

  private setupPingPong(): void {
    if (!this.ws) return;

    this.ws.on('pong', () => {
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    });

    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        
        this.pongTimeout = setTimeout(() => {
          console.warn(`[FirehoseConnection] Pong timeout for ${this.source.id}, terminating connection`);
          this.ws?.terminate();
        }, WS_PONG_TIMEOUT_MS);
      }
    }, WS_PING_INTERVAL_MS);
  }

  private cleanupTimers(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
    this.pingInterval = null;
    this.pongTimeout = null;
  }

  private async commitCursorSafely(): Promise<void> {
    if (this.lastAckedSeq === null) return;
    try {
      await this.cursorManager.commitCursor(this.source.id, this.lastAckedSeq);
    } catch (err) {
      console.error(`[FirehoseConnection] Failed to commit cursor for ${this.source.id}:`, err);
    }
  }

  private calculateBackoff(): number {
    // Exponential backoff: 100ms, 200ms, 400ms, 800ms... max 30s
    const baseDelay = 100;
    const maxDelay = 30_000;
    const exp = Math.min(this.reconnectAttempts - 1, 10); // cap exponent
    const delay = baseDelay * Math.pow(2, exp);
    
    // Add ±20% jitter
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    return Math.min(delay * jitter, maxDelay);
  }
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

function validateSourceUrl(urlStr: string): void {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('URL must use ws:// or wss:// protocol');
    }
  } catch (err) {
    throw new Error(`Invalid source URL "${urlStr}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
