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
import type { AtIngressEvent } from "../ingress/AtIngressEvents.js";

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
    this.isRunning = true;
    this.logger.info("AtJetstreamService starting", {
      url: this.config.url,
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

    this.logger.info("Connecting to Jetstream", { url: this.config.url });

    const ws = new WebSocket(this.config.url, {
      maxPayload: MAX_FRAME_SIZE_BYTES,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.logger.info("Jetstream connected", { url: this.config.url });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
      this.handleMessage(text).catch((err) => {
        this.logger.error("Unhandled error in Jetstream message handler", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    ws.on("close", (code, reason) => {
      this.ws = null;
      if (!this.isRunning) return;
      this.logger.warn("Jetstream connection closed, will reconnect", {
        code,
        reason: reason.toString(),
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
    this.reconnectAttempts++;
    // Exponential backoff: 500ms, 1s, 2s … 30s max
    const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
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

    const timeUs = typeof p["time_us"] === "number" ? p["time_us"] : Date.now() * 1000;
    const rev =
      typeof c["rev"] === "string" ? c["rev"] : `jetstream-${timeUs}`;
    const cid = typeof c["cid"] === "string" ? c["cid"] : null;
    const record =
      c["record"] && typeof c["record"] === "object" && !Array.isArray(c["record"])
        ? (c["record"] as Record<string, unknown>)
        : null;

    const event: AtIngressEvent = {
      seq: timeUs,
      did,
      eventType: "#commit",
      verifiedAt: new Date().toISOString(),
      source: this.config.url,
      commit: {
        rev,
        operation: normalizeOperation(c["operation"]),
        collection,
        rkey,
        cid,
        record,
        signatureValid: true,
      },
    };

    try {
      await this.publisher.publish(this.config.publishTopic, event);
      this.forwarded++;

      this.logger.info("Jetstream event published", {
        collection,
        operation: event.commit!.operation,
        did,
        forwarded: this.forwarded,
      });
    } catch (err) {
      this.logger.error("Failed to publish Jetstream event", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
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

function normalizeOperation(raw: unknown): "create" | "update" | "delete" {
  if (raw === "create" || raw === "update" || raw === "delete") return raw;
  return "create";
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
    if (u.protocol !== "wss:" && u.protocol !== "ws:") {
      throw new Error("must use ws:// or wss://");
    }
    return u.toString();
  } catch (err) {
    throw new Error(
      `Invalid JETSTREAM_URL "${raw}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
