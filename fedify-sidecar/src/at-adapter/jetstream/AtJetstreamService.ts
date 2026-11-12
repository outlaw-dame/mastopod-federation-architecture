/**
 * AtJetstreamService
 *
 * Connects to the Bluesky Jetstream WebSocket firehose and publishes
 * unverified observations to a dedicated staging topic. Jetstream JSON
 * does not carry repository signature proofs and must never populate the
 * trusted at.ingress.v1 topic directly.
 *
 * Jetstream is a lightweight JSON alternative to the CBOR-based
 * com.atproto.sync.subscribeRepos firehose. Events arrive pre-decoded and
 * do not require CAR/CBOR parsing or cryptographic signature verification,
 * making ingress cheaper to operate.
 *
 * Public endpoints (round-robin recommended):
 *   wss://jetstream1.us-east.bsky.network/subscribe
 *   wss://jetstream2.us-east.bsky.network/subscribe
 *
 * Key query parameters:
 *   wantedCollections — comma-separated NSID filter (e.g. app.bsky.feed.post)
 *   cursor            — Unix microseconds timestamp for resumption
 *
 * Ref: https://docs.bsky.app/docs/advanced-guides/jetstream
 */

import { WebSocket } from "ws";


/**
 * Minimal publisher interface satisfied by RedpandaEventPublisher.
 * Avoids the CoreIdentityEvent generic constraint for out-of-band topics.
 */
export interface AtJetstreamPublisher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(topic: string, event: any, metadata?: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FRAME_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 16;
const RECONNECT_REWIND_US = 5_000_000;
export const AT_JETSTREAM_UNVERIFIED_TOPIC = "at.jetstream.unverified.v1";

export interface AtJetstreamUnverifiedEvent {
  source: string;
  receivedAt: string;
  cursor: number;
  cursorType: "seq" | "time_us";
  kind: "commit";
  did: string;
  commit: {
    rev: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid: string | null;
    record: Record<string, unknown> | null;
  };
  verified: false;
}


// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface AtJetstreamConfig {
  /** Full Jetstream subscribe URL including any query parameters. */
  url: string;

  /** Must be the unverified Jetstream staging topic, never trusted ingress. */
  publishTopic: string;

  /**
   * If set, the service shuts down after this many events have been successfully
   * published. Useful for deterministic smoke tests (JETSTREAM_MAX_EVENTS=1).
   */
  maxEvents?: number;
}

export interface AtJetstreamLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Noop logger
// ---------------------------------------------------------------------------

const NOOP_LOGGER: AtJetstreamLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AtJetstreamService {
  private ws: WebSocket | null = null;
  private isRunning = false;
  private forwarded = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private onMaxEventsReached: (() => void) | null = null;
  private lastCommittedCursor: { value: number; type: "seq" | "time_us" } | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly publisher: AtJetstreamPublisher,
    private readonly config: AtJetstreamConfig,
    private readonly logger: AtJetstreamLogger = NOOP_LOGGER,
  ) {
    // Jetstream JSON omits the repository cryptographic proofs that are
    // mandatory for at.ingress.v1. A configurable trusted topic would let
    // unverified public data mutate verified repositories.
    if (config.publishTopic !== AT_JETSTREAM_UNVERIFIED_TOPIC) {
      throw new Error("Jetstream may publish only to the unverified staging topic");
    }
  }

  /**
   * Register a callback invoked when maxEvents is reached.
   * In production this is used to trigger a clean sidecar shutdown.
   */
  onMaxEvents(cb: () => void): this {
    this.onMaxEventsReached = cb;
    return this;
  }

  /** Start the connection loop. Returns immediately. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info("AtJetstreamService starting", {
      source: safeEndpointLabel(this.config.url),
      publishTopic: this.config.publishTopic,
      maxEvents: this.config.maxEvents ?? null,
    });
    this.connect();
  }

  /** Stop the connection loop and close the WebSocket. */
  shutdown(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.logger.info("AtJetstreamService shutting down");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close(1000, "shutdown");
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private connect(): void {
    if (!this.isRunning) return;

    const target = new URL(this.config.url);
    // v2 uses an inclusive monotonic seq. Legacy v1 uses microseconds
    // and a small rewind to cover reordered events and reconnect races.
    if (this.lastCommittedCursor) {
      const checkpoint = this.lastCommittedCursor;
      const cursor = checkpoint.type === "seq" ?
        checkpoint.value :
        Math.max(0, checkpoint.value - RECONNECT_REWIND_US);
      target.searchParams.set("cursor", String(cursor));
    }
    this.logger.info("Connecting to Jetstream", {
      endpoint: safeEndpointLabel(target.toString()),
      resumable: this.lastCommittedCursor !== null,
    });
    const ws = new WebSocket(target.toString(), {
      maxPayload: MAX_FRAME_SIZE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    this.ws = ws;

    let queue: Array<{text:string;bytes:number}> = [];
    let pendingBytes = 0;
    let draining = false;
    let alive = true;
    const stopHeartbeat = () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    };
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      let failed = false;
      try {
        while (queue.length > 0 && this.isRunning && this.ws === ws) {
          const item = queue.shift()!;
          pendingBytes -= item.bytes;
          // Deliberately serial. Cursor advances only after an actual
          // Redpanda publish; another message cannot overtake the failed one.
          await this.handleMessage(item.text);
        }
      } catch (error) {
        failed = true;
        this.logger.error("Jetstream publish failed; resuming from last committed cursor", {
          code: error instanceof Error ? error.name : "PUBLISH_FAILURE",
        });
        ws.terminate();
      } finally {
        // Resume only AFTER clearing the drain flag. The ws library can
        // synchronously emit queued events from resume(); clearing the queue
        // afterwards would silently discard those newly arrived messages.
        draining = false;
        if (failed) {
          queue = [];
          pendingBytes = 0;
        } else if (queue.length > 0) {
          void drain();
        } else if (this.isRunning && this.ws === ws &&
                   ws.readyState === WebSocket.OPEN) {
          ws.resume();
        }
      }
    };

    ws.on("open", () => {
      alive = true;
      this.logger.info("Jetstream connected", {
        endpoint: safeEndpointLabel(this.config.url),
      });
      stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        try { ws.ping(); } catch { ws.terminate(); }
      }, 30000);
      this.heartbeatTimer.unref?.();
    });
    ws.on("pong", () => { alive = true; });
    ws.on("message", (data, isBinary) => {
      if (isBinary || !this.isRunning || this.ws !== ws) return;
      const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
      const bytes = Buffer.byteLength(text, "utf8");
      if (queue.length >= MAX_PENDING_MESSAGES || pendingBytes + bytes > MAX_PENDING_BYTES) {
        // A bounded overflow is safer than buffering arbitrarily while the
        // broker is slow. Reconnect replays from the committed cursor.
        this.logger.warn("Jetstream subscriber exceeded backpressure budget");
        ws.terminate();
        return;
      }
      queue.push({text,bytes});
      pendingBytes += bytes;
      ws.pause();
      void drain();
    });
    ws.on("close", (code) => {
      stopHeartbeat();
      // A delayed close from an older connection must never schedule an
      // overlapping reconnect after a new connection is already live.
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.isRunning) return;
      this.logger.warn("Jetstream disconnected", {code});
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      this.logger.error("Jetstream transport error", {
        code: error.name,
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;
    this.reconnectAttempts++;
    // Capped full jitter avoids coordinated reconnect storms across replicas.
    const ceiling = Math.min(30000, 500 * 2 ** Math.min(16, this.reconnectAttempts - 1));
    const delay = Math.max(250, Math.floor(Math.random() * ceiling));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  private async handleMessage(text: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return; // malformed JSON — skip silently
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>)["kind"] !== "commit"
    ) {
      return; // identity / account / info frames — not yet consumed
    }

    const p = payload as Record<string, unknown>;
    const commit = p["commit"];
    const did = typeof p["did"] === "string" ? p["did"] : null;

    if (!did || !commit || typeof commit !== "object") return;

    const c = commit as Record<string, unknown>;
    const collection = typeof c["collection"] === "string" ? c["collection"] : null;
    const rkey = typeof c["rkey"] === "string" ? c["rkey"] : null;

    if (!collection || !rkey) return;

    const seq = p["seq"];
    const timeUs = p["time_us"];
    const cursorType: "seq" | "time_us" =
      typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ?
        "seq" : "time_us";
    const cursor = cursorType === "seq" ? seq : timeUs;
    if (typeof cursor !== "number" ||
        !Number.isSafeInteger(cursor) || cursor <= 0) return;
    const operation = normalizeOperation(c["operation"]);
    if (!operation) return;
    const rev = typeof c["rev"] === "string" ? c["rev"] : `jetstream-${cursor}`;
    const cid = typeof c["cid"] === "string" ? c["cid"] : null;
    const record =
      c["record"] && typeof c["record"] === "object" && !Array.isArray(c["record"])
        ? c["record"] as Record<string, unknown> : null;

    const event: AtJetstreamUnverifiedEvent = {
      source: safeEndpointLabel(this.config.url),
      receivedAt: new Date().toISOString(),
      cursor, cursorType,
      kind: "commit",did,
      commit:{rev,operation,collection,rkey,cid,record},
      verified:false,
    };
    // The queue is intentionally serial. If the broker rejects the write,
    // throw and close the WebSocket without advancing the reconnect cursor.
    await this.publisher.publish(this.config.publishTopic, event);
    this.forwarded++;
    if (!this.lastCommittedCursor ||
        this.lastCommittedCursor.type !== cursorType ||
        cursor > this.lastCommittedCursor.value) {
      this.lastCommittedCursor = {value:cursor,type:cursorType};
    }
    this.reconnectAttempts = 0;
    if (this.forwarded % 1000 === 0) {
      this.logger.info("Jetstream unverified observations staged", {
        count:this.forwarded,
      });
    }

    if (this.config.maxEvents && this.forwarded >= this.config.maxEvents) {
      this.logger.info("Jetstream maxEvents reached", {
        maxEvents: this.config.maxEvents,
      });
      this.shutdown();
      if (this.onMaxEventsReached) {
        this.onMaxEventsReached();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOperation(raw: unknown): "create" | "update" | "delete" | null {
  if (raw === "create" || raw === "update" || raw === "delete") return raw;
  return null;
}
function safeEndpointLabel(source: string): string {
  const uri = new URL(source);
  return uri.origin + uri.pathname;
}

// ---------------------------------------------------------------------------
// URL builder helper
// ---------------------------------------------------------------------------

export const DEFAULT_JETSTREAM_URL =
  "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post";

/**
 * Parse and validate JETSTREAM_URL env var, falling back to the default.
 * Throws if the value is set but is not a valid wss:// URL.
 */
export function parseJetstreamUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_JETSTREAM_URL;
  try {
    const u = new URL(raw);
    const allowedLocalHttp = u.protocol === "ws:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      process.env["NODE_ENV"] === "test";
    if ((u.protocol !== "wss:" && !allowedLocalHttp) ||
        u.username || u.password || u.hash) {
      throw new Error("Jetstream requires WSS, except disposable loopback tests");
    }
    return u.toString();
  } catch {
    throw new Error("Invalid JETSTREAM_URL: canonical WSS endpoint required");
  }
}
