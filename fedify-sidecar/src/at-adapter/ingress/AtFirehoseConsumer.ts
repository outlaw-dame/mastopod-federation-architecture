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
// Heartbeat liveness is tracked with a single interval, avoiding per-ping timers.

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

// A slow broker cannot cause overlapping frame handlers or unbounded process
// memory. A single source has one active publish and at most two queued frames.
const MAX_PENDING_FRAMES = 2;
const MAX_PENDING_BYTES = 10 * 1024 * 1024;
const WS_RECONNECT_CEILING_MS = 30_000;

export class DefaultAtFirehoseConsumer implements AtFirehoseConsumer {
  private readonly activeConnections = new Map<string, FirehoseConnection>();

  constructor(
    private readonly decoder: AtFirehoseDecoder,
    private readonly cursorManager: AtFirehoseCursorManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rawTopic = RAW_FIREHOSE_TOPIC,
  ) {}

  async start(source: AtFirehoseSource): Promise<void> {
    if (this.activeConnections.has(source.id)) {
      throw new Error("External firehose source already running");
    }
    validateSourceUrl(source.url);
    if (!/^at\.firehose\.raw(?:\.[a-z0-9_-]+)*\.v[0-9]+$/.test(this.rawTopic)) {
      throw new Error("External firehose raw topic must remain in the untrusted raw namespace");
    }

    const connection = new FirehoseConnection(
      source, this.decoder, this.cursorManager, this.eventPublisher, this.rawTopic,
    );
    this.activeConnections.set(source.id, connection);
    void connection.startLoop().catch((error: unknown) => {
      console.error("[AtFirehoseConsumer] Source loop failed", {
        sourceId: source.id,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }).finally(() => {
      if (this.activeConnections.get(source.id) === connection) {
        this.activeConnections.delete(source.id);
      }
    });
  }

  async stop(sourceId: string): Promise<void> {
    const connection = this.activeConnections.get(sourceId);
    if (!connection) return;
    try {
      await connection.stop();
    } finally {
      this.activeConnections.delete(sourceId);
    }
  }
}

class FirehoseConnection {
  private ws: WebSocket | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private pingInterval: NodeJS.Timeout | null = null;
  private commitInterval: NodeJS.Timeout | null = null;
  private lastAckedSeq: number | null = null;
  private lastCommittedSeq: number | null = null;
  private checkpointChain: Promise<void> = Promise.resolve();
  private stopReconnectWait: (() => void) | null = null;

  constructor(
    private readonly source: AtFirehoseSource,
    private readonly decoder: AtFirehoseDecoder,
    private readonly cursorManager: AtFirehoseCursorManager,
    private readonly eventPublisher: EventPublisher,
    private readonly rawTopic: string,
  ) {}

  async startLoop(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    // Cursor flushing must persist across reconnects, not be accidentally
    // destroyed by the socket's close handler.
    this.commitInterval = setInterval(() => { void this.commitCursorSafely(); },
      CURSOR_COMMIT_INTERVAL_MS);
    this.commitInterval.unref?.();
    try {
      while (this.isRunning) {
        try {
          await this.connectAndWait();
        } catch (error) {
          if (!this.isRunning) break;
          console.error("[FirehoseConnection] External source disconnected", {
            sourceId: this.source.id,
            code: error instanceof Error ? error.name : "UNKNOWN",
          });
        }
        if (!this.isRunning) break;
        this.reconnectAttempts = Math.min(16, this.reconnectAttempts + 1);
        await this.waitForReconnect();
      }
    } finally {
      this.cleanupSocket();
      if (this.commitInterval) clearInterval(this.commitInterval);
      this.commitInterval = null;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.stopReconnectWait?.();
    this.stopReconnectWait = null;
    if (this.ws) this.ws.terminate();
    this.cleanupSocket();
    if (this.commitInterval) clearInterval(this.commitInterval);
    this.commitInterval = null;
    // Drain only completed, acknowledged messages. An outstanding broker
    // operation is deliberately not awaited: it cannot advance a closed
    // session's cursor and will be replayed after restart.
    await this.commitCursorSafely();
  }

  private async connectAndWait(): Promise<void> {
    const cursor = await this.cursorManager.getResumeCursor(this.source.id);
    if (!this.isRunning) return;
    const url = new URL(this.source.url);
    if (url.pathname === "/") url.pathname = "/xrpc/com.atproto.sync.subscribeRepos";
    if (cursor !== null) {
      url.searchParams.set("cursor", String(cursor));
      // Inclusive cursors must not replay already broker-acknowledged frames
      // as new work during reconnects within this process.
      if (this.lastAckedSeq === null) this.lastAckedSeq = cursor;
    }
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url.toString(), {
          maxPayload: MAX_FRAME_SIZE_BYTES,
          perMessageDeflate: false,
          maxRedirects: 0,
          handshakeTimeout: 10_000,
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = ws;
      let pendingFrames: Buffer[] = [];
      let pendingBytes = 0;
      let draining = false;
      let pongReceived = true;
      const stopPing = () => {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
      };
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          while (this.isRunning && this.ws === ws &&
                 ws.readyState === WebSocket.OPEN && pendingFrames.length) {
            const frame = pendingFrames.shift()!;
            pendingBytes -= frame.byteLength;
            await this.handleFrame(frame, ws);
          }
        } catch (error) {
          console.error("[FirehoseConnection] Frame processing failed", {
            sourceId: this.source.id,
            code: error instanceof Error ? error.name : "UNKNOWN",
          });
          ws.terminate();
        } finally {
          draining = false;
          if (!this.isRunning || this.ws !== ws ||
              ws.readyState !== WebSocket.OPEN) {
            pendingFrames = [];
            pendingBytes = 0;
          } else if (pendingFrames.length) {
            void drain();
          } else {
            ws.resume();
          }
        }
      };

      ws.on("open", () => {
        if (!this.isRunning || this.ws !== ws) {
          ws.terminate();
          return;
        }
        pongReceived = true;
        stopPing();
        this.pingInterval = setInterval(() => {
          if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
          if (!pongReceived) {
            ws.terminate();
            return;
          }
          pongReceived = false;
          try { ws.ping(); } catch { ws.terminate(); }
        }, WS_PING_INTERVAL_MS);
        this.pingInterval.unref?.();
      });
      ws.on("pong", () => { pongReceived = true; });
      ws.on("message", (data, isBinary) => {
        if (!this.isRunning || this.ws !== ws || !isBinary) {
          ws.terminate();
          return;
        }
        const frame = Buffer.isBuffer(data) ? data :
          Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (pendingFrames.length >= MAX_PENDING_FRAMES ||
            frame.byteLength > MAX_FRAME_SIZE_BYTES ||
            frame.byteLength + pendingBytes > MAX_PENDING_BYTES) {
          ws.terminate();
          return;
        }
        pendingFrames.push(frame);
        pendingBytes += frame.byteLength;
        ws.pause();
        void drain();
      });
      ws.once("close", () => {
        stopPing();
        if (this.ws === ws) this.ws = null;
        pendingFrames = [];
        pendingBytes = 0;
        resolve();
      });
      ws.once("error", (error) => {
        stopPing();
        ws.terminate();
        reject(error);
      });
    });
  }

  private async handleFrame(frame: Uint8Array, socket: WebSocket): Promise<void> {
    const header = this.decoder.decodeHeader(frame);
    if (header.seq > 0 && this.lastAckedSeq !== null &&
        header.seq <= this.lastAckedSeq) return;
    const envelope: AtFirehoseRawEnvelope = {
      seq: header.seq,
      source: this.source.url,
      receivedAt: new Date().toISOString(),
      eventType: header.eventType,
      did: header.did,
      rawCborBase64: Buffer.from(frame).toString("base64"),
    };
    // Strictly serial: a later sequence must never overtake an unacknowledged
    // frame during broker congestion or a partial network failure.
    await this.eventPublisher.publish(this.rawTopic, envelope as any);
    if (!this.isRunning || this.ws !== socket ||
        socket.readyState !== WebSocket.OPEN) return;
    if (header.seq > 0) {
      await this.cursorManager.setHotCursor(this.source.id, header.seq);
      this.lastAckedSeq = header.seq;
    }
    this.reconnectAttempts = 0;
  }

  private async commitCursorSafely(): Promise<void> {
    const seq = this.lastAckedSeq;
    if (seq === null || (this.lastCommittedSeq !== null &&
        seq <= this.lastCommittedSeq)) return this.checkpointChain;
    // Serialize concurrent timer/shutdown flushes; an older checkpoint must
    // never overwrite a newer one on this single source.
    this.checkpointChain = this.checkpointChain.catch(() => undefined).then(async () => {
      if (this.lastCommittedSeq !== null && seq <= this.lastCommittedSeq) return;
      await this.cursorManager.commitCursor(this.source.id, seq);
      this.lastCommittedSeq = seq;
    });
    try {
      await this.checkpointChain;
    } catch (error) {
      console.error("[FirehoseConnection] Checkpoint save failed", {
        sourceId: this.source.id,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  }

  private async waitForReconnect(): Promise<void> {
    const max = Math.min(WS_RECONNECT_CEILING_MS,
      500 * 2 ** Math.min(10, this.reconnectAttempts - 1));
    const delay = Math.max(250, Math.floor(Math.random() * max));
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.stopReconnectWait = null;
        resolve();
      };
      const timer = setTimeout(done, delay);
      this.stopReconnectWait = done;
    });
  }

  private cleanupSocket(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

function validateSourceUrl(source: string): void {
  let url: URL;
  try { url = new URL(source); }
  catch { throw new Error("External firehose source is not a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && loopback && process.env["NODE_ENV"] === "test")) {
    throw new Error("External firehose requires WSS outside disposable loopback tests");
  }
  if (url.username || url.password || url.search || url.hash ||
      !["/", "/xrpc/com.atproto.sync.subscribeRepos"].includes(url.pathname)) {
    throw new Error("External firehose URL must have no credentials, query or non-sync path");
  }
}
