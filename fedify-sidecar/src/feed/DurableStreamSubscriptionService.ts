/**
 * DurableStreamSubscriptionService
 *
 * Manages in-process fan-out of stream envelopes to SSE and WebSocket consumers.
 * Responsibilities:
 *  - Auth scope enforcement per stream + transport combination
 *  - Per-connection cursor tracking (in-memory, v1)
 *  - Fan-out: publish envelopes to all matching active connections
 *  - Heartbeat to keep connections alive (SSE comment / WS ping)
 *  - Graceful cleanup on connection close / server shutdown
 *
 * Design constraints:
 *  - No Redis or external persistence for cursors in v1 (in-process only)
 *  - Cursor format matches the existing base64url-JSON pattern from OpenSearchFeedProvider
 *  - All inputs validated with Zod before touching internal state
 *  - timingSafeEqual for token comparison; no direct string compare for secrets
 *  - Maximum 10_000 concurrent stream connections enforced at accept time
 */

import { timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import type { WebSocket } from "ws";
import {
  StreamSubscriptionRequestSchema,
  StreamEnvelopeSchema,
  DurableStreamCapabilitySchema,
  type StreamSubscriptionRequest,
  type StreamEnvelope,
  type DurableStreamCapability,
  type DurableTransport,
  type DurableStreamName,
} from "./DurableStreamContracts.js";

// ---------------------------------------------------------------------------
// Internal cursor type (opaque base64url-encoded JSON blob)
// ---------------------------------------------------------------------------
interface CursorState {
  eventId: string;
  occurredAt: string;
  streams: DurableStreamName[];
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "eventId" in parsed &&
      "occurredAt" in parsed &&
      "streams" in parsed
    ) {
      const p = parsed as { eventId: unknown; occurredAt: unknown; streams: unknown };
      if (
        typeof p.eventId === "string" &&
        typeof p.occurredAt === "string" &&
        Array.isArray(p.streams)
      ) {
        return { eventId: p.eventId, occurredAt: p.occurredAt, streams: p.streams as DurableStreamName[] };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capability registry — injected at construction time
// ---------------------------------------------------------------------------
export type StreamCapabilityLookup = (stream: DurableStreamName) => DurableStreamCapability | undefined;

// ---------------------------------------------------------------------------
// Connection representation
// ---------------------------------------------------------------------------
type SseConnectionHandle = {
  kind: "sse";
  id: string;
  streams: ReadonlySet<DurableStreamName>;
  /** Write a formatted SSE event line block. Returns false when the response is closed. */
  send(event: string, data: string, id?: string): boolean;
  /** Terminate the connection from the server side. */
  close(): void;
};

type WsConnectionHandle = {
  kind: "websocket";
  id: string;
  streams: ReadonlySet<DurableStreamName>;
  socket: WebSocket;
};

type ConnectionHandle = SseConnectionHandle | WsConnectionHandle;

// ---------------------------------------------------------------------------
// Public error types
// ---------------------------------------------------------------------------
export class DurableStreamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "DurableStreamError";
  }
}

// ---------------------------------------------------------------------------
// Service options
// ---------------------------------------------------------------------------
export interface DurableStreamSubscriptionServiceOptions {
  /** Bearer token used to authenticate internal consumers. */
  sidecarToken: string;
  /** Resolves capability metadata for a given stream name. */
  capabilityLookup: StreamCapabilityLookup;
  /** Maximum concurrent connections across SSE + WS (default: 10_000). */
  maxConnections?: number;
  /** Heartbeat interval in milliseconds (default: 30_000). */
  heartbeatIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Validated subscription context (result of authoriseRequest)
// ---------------------------------------------------------------------------
export interface SubscriptionContext {
  connectionId: string;
  transport: DurableTransport;
  streams: ReadonlySet<DurableStreamName>;
  viewerId: string | undefined;
  resumeCursor: CursorState | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class DurableStreamSubscriptionService {
  private readonly sidecarToken: string;
  private readonly capabilityLookup: StreamCapabilityLookup;
  private readonly maxConnections: number;
  private readonly heartbeatIntervalMs: number;

  /** All active connections keyed by connectionId. */
  private readonly connections = new Map<string, ConnectionHandle>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DurableStreamSubscriptionServiceOptions) {
    if (!options.sidecarToken) {
      throw new Error("DurableStreamSubscriptionService: sidecarToken is required");
    }
    this.sidecarToken = options.sidecarToken;
    this.capabilityLookup = options.capabilityLookup;
    this.maxConnections = Math.min(Math.max(0, options.maxConnections ?? 10_000), 50_000);
    this.heartbeatIntervalMs = Math.min(Math.max(5_000, options.heartbeatIntervalMs ?? 30_000), 120_000);
  }

  /**
   * Start the heartbeat timer. Must be called once after construction.
   * Idempotent.
   */
  start(): void {
    if (this.heartbeatTimer !== null) return;

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, this.heartbeatIntervalMs);

    this.heartbeatTimer.unref?.();
  }

  /**
   * Stop heartbeat and terminate all active connections. Call on server shutdown.
   */
  shutdown(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const conn of this.connections.values()) {
      try {
        if (conn.kind === "sse") {
          conn.close();
        } else {
          if (conn.socket.readyState === conn.socket.OPEN) {
            conn.socket.close(1001, "server shutdown");
          }
        }
      } catch {
        // best effort
      }
    }

    this.connections.clear();
  }

  /**
   * Validate and authorise an incoming subscription request.
   * Throws DurableStreamError on auth/validation failure.
   */
  authoriseRequest(
    rawRequest: unknown,
    authorizationHeader: string | undefined,
    permissionsHeader: string | undefined,
  ): SubscriptionContext {
    // Token check (timing-safe)
    if (!isAuthorized(authorizationHeader, this.sidecarToken)) {
      throw new DurableStreamError("unauthorized", "unauthorized", 401);
    }

    if (!hasReadPermission(permissionsHeader)) {
      throw new DurableStreamError(
        "Missing required permission: provider:read",
        "forbidden",
        403,
      );
    }

    const parse = StreamSubscriptionRequestSchema.safeParse(rawRequest);
    if (!parse.success) {
      throw new DurableStreamError(
        parse.error.issues.map((issue) => issue.message).join("; "),
        "invalid_request",
        400,
      );
    }

    const req: StreamSubscriptionRequest = parse.data;

    // Per-stream capability checks
    for (const streamName of req.streams) {
      const cap = this.capabilityLookup(streamName);
      if (!cap) {
        throw new DurableStreamError(
          `Stream "${streamName}" is not available`,
          "stream_not_found",
          404,
        );
      }
      if (req.transport === "sse" && !cap.supportsSse) {
        throw new DurableStreamError(
          `Stream "${streamName}" does not support SSE transport`,
          "transport_not_supported",
          422,
        );
      }
      if (req.transport === "websocket" && !cap.supportsWebSocket) {
        throw new DurableStreamError(
          `Stream "${streamName}" does not support WebSocket transport`,
          "transport_not_supported",
          422,
        );
      }
    }

    const resumeCursor = req.cursor ? decodeCursor(req.cursor) : null;

    return {
      connectionId: randomUUID(),
      transport: req.transport,
      streams: new Set(req.streams),
      viewerId: req.viewerId,
      resumeCursor,
    };
  }

  /**
   * Check whether the service can accept a new connection.
   * Returns false if at capacity.
   */
  canAcceptConnection(): boolean {
    return this.connections.size < this.maxConnections;
  }

  /**
   * Return the number of currently active connections for a given transport.
   */
  getConnectionCountByTransport(transport: "sse" | "websocket"): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.kind === (transport === "websocket" ? "websocket" : "sse")) count++;
    }
    return count;
  }

  /**
   * Register an SSE connection. Returns a cleanup function the caller must
   * invoke when the HTTP response closes.
   */
  registerSseConnection(
    ctx: SubscriptionContext,
    send: SseConnectionHandle["send"],
    close: SseConnectionHandle["close"],
  ): () => void {
    const handle: SseConnectionHandle = {
      kind: "sse",
      id: ctx.connectionId,
      streams: ctx.streams,
      send,
      close,
    };
    this.connections.set(ctx.connectionId, handle);
    return () => {
      this.connections.delete(ctx.connectionId);
    };
  }

  /**
   * Register a WebSocket connection. Returns a cleanup function.
   */
  registerWsConnection(ctx: SubscriptionContext, socket: WebSocket): () => void {
    const handle: WsConnectionHandle = {
      kind: "websocket",
      id: ctx.connectionId,
      streams: ctx.streams,
      socket,
    };
    this.connections.set(ctx.connectionId, handle);
    return () => {
      this.connections.delete(ctx.connectionId);
    };
  }

  /**
   * Publish a validated envelope to all connections subscribed to that stream.
   * Invalid envelopes are silently dropped (schema validation failure = corrupt data
   * from upstream, not a consumer concern).
   */
  publish(rawEnvelope: unknown): void {
    const parse = StreamEnvelopeSchema.safeParse(rawEnvelope);
    if (!parse.success) return;

    const envelope: StreamEnvelope = parse.data;

    for (const conn of this.connections.values()) {
      if (!conn.streams.has(envelope.stream)) continue;

      try {
        if (conn.kind === "sse") {
          this.sendSseEnvelope(conn, envelope);
        } else {
          this.sendWsEnvelope(conn, envelope);
        }
      } catch {
        // best effort — individual send failures must not block the fan-out loop
        this.connections.delete(conn.id);
      }
    }
  }

  /**
   * Build and return the current cursor string for a connection (for SSE
   * Last-Event-ID handshake). Returns undefined if no events have been sent yet.
   */
  buildCursor(streams: ReadonlySet<DurableStreamName>, lastEnvelope: StreamEnvelope): string {
    return encodeCursor({
      eventId: lastEnvelope.eventId,
      occurredAt: lastEnvelope.occurredAt,
      streams: Array.from(streams) as DurableStreamName[],
    });
  }

  /** Number of currently registered connections. Exposed for metrics. */
  get connectionCount(): number {
    return this.connections.size;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  private sendSseEnvelope(conn: SseConnectionHandle, envelope: StreamEnvelope): void {
    const data = JSON.stringify(envelope);
    const alive = conn.send("envelope", data, envelope.eventId);
    if (!alive) {
      this.connections.delete(conn.id);
    }
  }

  private sendWsEnvelope(conn: WsConnectionHandle, envelope: StreamEnvelope): void {
    if (conn.socket.readyState !== conn.socket.OPEN) {
      this.connections.delete(conn.id);
      return;
    }
    conn.socket.send(JSON.stringify({ type: "envelope", data: envelope }));
  }

  private sendHeartbeats(): void {
    for (const conn of this.connections.values()) {
      try {
        if (conn.kind === "sse") {
          const alive = conn.send("heartbeat", "{}");
          if (!alive) {
            this.connections.delete(conn.id);
          }
        } else {
          if (conn.socket.readyState === conn.socket.OPEN) {
            conn.socket.ping();
          } else {
            this.connections.delete(conn.id);
          }
        }
      } catch {
        this.connections.delete(conn.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auth helpers (same semantics as fastify-routes.ts)
// ---------------------------------------------------------------------------
function isAuthorized(header: string | undefined, token: string): boolean {
  if (!token || typeof header !== "string") return false;
  const [scheme, supplied] = header.split(" ");
  if (scheme !== "Bearer" || typeof supplied !== "string") return false;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(token, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hasReadPermission(raw: string | undefined): boolean {
  if (typeof raw !== "string") return false;
  return raw.split(",").map((value) => value.trim()).includes("provider:read");
}

// ---------------------------------------------------------------------------
// Default capability lookup builder — convenience factory used in fastify-routes
// ---------------------------------------------------------------------------
export function buildCapabilityLookup(
  capabilities: DurableStreamCapability[],
): StreamCapabilityLookup {
  const map = new Map<DurableStreamName, DurableStreamCapability>();
  for (const cap of capabilities) {
    const parse = DurableStreamCapabilitySchema.safeParse(cap);
    if (parse.success) {
      map.set(parse.data.stream, parse.data);
    }
  }
  return (stream) => map.get(stream);
}

// Re-export schema type for callers
export type { StreamSubscriptionRequest, StreamEnvelope, DurableStreamCapability };
