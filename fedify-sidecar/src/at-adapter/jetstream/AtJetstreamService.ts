/**
 * AtJetstreamService
 *
 * Connects to the Bluesky Jetstream WebSocket firehose and publishes
 * normalised AtIngressEvents to the at.ingress.v1 topic.
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
// Jetstream JSON is transport data, not cryptographically verified ingress.
export const UNVERIFIED_JETSTREAM_TOPIC = "at.jetstream.unverified.v1";
export interface UnverifiedJetstreamCommit {
  kind: "jetstream.commit";
  verified: false;
  source: string;
  receivedAt: string;
  timeUs: number;
  did: string;
  commit: {
    rev: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid: string | null;
    record: Record<string, unknown> | null;
  };
}

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

const MAX_FRAME_SIZE_BYTES = 1024 * 1024;
const MAX_PENDING_FRAMES = 8;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const REWIND_MICROSECONDS = 5_000_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface AtJetstreamConfig {
  /** Full Jetstream subscribe URL including any query parameters. */
  url: string;

  /** RedPanda topic to publish normalised events into. Defaults to at.ingress.v1. */
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
  private processing: Promise<void> = Promise.resolve();
  private pendingFrames = 0;
  private pendingBytes = 0;
  // This is an in-memory v1 cursor. Restart durability still requires a
  // persistent cursor store and at-least-once consumer deduplication.
  private lastPublishedTimeUs: number | null = null;

  constructor(
    private readonly publisher: AtJetstreamPublisher,
    private readonly config: AtJetstreamConfig,
    private readonly logger: AtJetstreamLogger = NOOP_LOGGER,
  ) {}

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
    if (this.config.publishTopic !== UNVERIFIED_JETSTREAM_TOPIC) {
      throw new Error("Unverified Jetstream events cannot be published to trusted ingress");
    }
    parseJetstreamUrl(this.config.url);
    this.isRunning = true;
    this.logger.info("AtJetstreamService starting", {
      host: new URL(this.config.url).host,
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

    const connectUrl = new URL(this.config.url);
    if (this.lastPublishedTimeUs !== null) {
      connectUrl.searchParams.set("cursor",
        String(Math.max(0, this.lastPublishedTimeUs - REWIND_MICROSECONDS)));
    }
    this.logger.info("Connecting to Jetstream", { host: connectUrl.host });
    const ws = new WebSocket(connectUrl.toString(), {
      maxPayload: MAX_FRAME_SIZE_BYTES,
      perMessageDeflate: false,
      maxRedirects: 0,
      handshakeTimeout: 10000,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.logger.info("Jetstream connected", { host: new URL(this.config.url).host });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || ws !== this.ws || !this.isRunning) return;
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (bytes > MAX_FRAME_SIZE_BYTES ||
          this.pendingFrames >= MAX_PENDING_FRAMES ||
          this.pendingBytes + bytes > MAX_PENDING_BYTES) {
        this.logger.warn("Jetstream publisher backlog exceeded budget");
        ws.terminate();
        return;
      }
      const message = typeof data === "string" ? data : data.toString("utf8");
      this.pendingFrames++;
      this.pendingBytes += bytes;
      ws.pause();
      this.processing = this.processing.then(async () => {
        if (!this.isRunning || ws !== this.ws) return;
        await this.handleMessage(message);
      }).catch(error => {
        this.logger.error("Jetstream publishing failed", {
          error: error instanceof Error ? error.name : "UNKNOWN",
        });
        if (ws.readyState === WebSocket.OPEN) ws.terminate();
      }).finally(() => {
        this.pendingFrames--;
        this.pendingBytes -= bytes;
        if (this.pendingFrames === 0 && this.isRunning &&
            ws === this.ws && ws.readyState === WebSocket.OPEN) ws.resume();
      });
    });

    ws.on("close", (code, reason) => {
      this.ws = null;
      if (!this.isRunning) return;
      this.logger.warn("Jetstream connection closed, will reconnect", {
        code,
        // Remote WebSocket close reasons are untrusted; log the code only.
      });
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.logger.error("Jetstream WebSocket error", {
        error: err.message,
      });
      // The 'close' event fires after 'error', so reconnect happens there.
    });
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 12);
    const ceiling = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    const delay = Math.max(250, Math.round(ceiling * (0.5 + Math.random() * 0.5)));
    this.logger.info("Scheduling Jetstream reconnect", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
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

    const timeUs = p["time_us"];
    if (typeof timeUs !== "number" || !Number.isSafeInteger(timeUs) || timeUs <= 0) return;
    const rev =
      typeof c["rev"] === "string" ? c["rev"] : `jetstream-${timeUs}`;
    const cid = typeof c["cid"] === "string" ? c["cid"] : null;
    const record =
      c["record"] && typeof c["record"] === "object" && !Array.isArray(c["record"])
        ? (c["record"] as Record<string, unknown>)
        : null;

    const operation = normalizeOperation(c["operation"]);
    if (!operation) return;
    const endpoint = new URL(this.config.url);
    const event: UnverifiedJetstreamCommit = {
      kind: "jetstream.commit",
      verified: false,
      timeUs,
      did,
      receivedAt: new Date().toISOString(),
      source: endpoint.origin + endpoint.pathname,
      commit: {
        rev,
        operation,
        collection,
        rkey,
        cid,
        record,
        // No ATProto signature or repository chain verification occurred.
      },
    };

    try {
      await this.publisher.publish(this.config.publishTopic, event);
      this.forwarded++;
      this.lastPublishedTimeUs = Math.max(this.lastPublishedTimeUs ?? 0, timeUs);
      // Avoid per-event user identifiers and hot-path logging overhead.
      if (this.forwarded % 1000 === 0) {
        this.logger.info("Unverified Jetstream records published", {
          forwarded: this.forwarded,
        });
      }
    } catch (err) {
      this.logger.error("Failed to publish Jetstream event", {
        error: err instanceof Error ? err.name : "UNKNOWN",
      });
      throw err;
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
    const loopback = process.env["NODE_ENV"] === "test" &&
      u.protocol === "ws:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if ((!loopback && u.protocol !== "wss:") ||
        u.username || u.password || u.hash ||
        (u.pathname !== "/subscribe" && u.pathname !== "/subscribe/")) {
      throw new Error("Expected canonical secure Jetstream /subscribe URL");
    }
    return u.toString();
  } catch (err) {
    throw new Error(
      "Invalid JETSTREAM_URL: expected a secure Jetstream /subscribe endpoint",
    );
  }
}
