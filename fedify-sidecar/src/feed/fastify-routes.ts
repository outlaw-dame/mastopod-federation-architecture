import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WebSocketServer, type WebSocket } from "ws";
import { FeedRequestSchema, HydrationRequestSchema } from "./contracts.js";
import { FeedRegistry } from "./FeedRegistry.js";
import { DefaultPodFeedService, PodFeedServiceError } from "./PodFeedService.js";
import { DefaultPodHydrationService } from "./PodHydrationService.js";
import {
  DurableStreamSubscriptionService,
  DurableStreamError,
} from "./DurableStreamSubscriptionService.js";
import { metrics as promMetrics } from "../metrics/index.js";

const listFeedsQuerySchema = z.object({
  viewerId: z.string().trim().min(1).max(2048).optional(),
});

/**
 * Minimal shape of a capability gate result.  Matches CapabilityGateResult
 * from capabilities/gates.ts without creating a hard import cycle.
 */
interface CapabilityGateResult {
  allowed: boolean;
  reasonCode?: string;
  message?: string;
  retryable?: boolean;
}

/**
 * Result of an entitlement limit check for stream connections.
 */
interface StreamEntitlementResult {
  allowed: boolean;
  effectiveLimit: number;
}

export interface FeedFastifyRouteDeps {
  sidecarToken: string;
  feedRegistry: FeedRegistry;
  feedService: DefaultPodFeedService;
  hydrationService: DefaultPodHydrationService;
  viewershipHistoryClient?: {
    resolveViewedObjectIds(input: { actorId: string; objectIds: string[] }): Promise<{ viewedObjectIds: string[] }>;
    recordView(input: { actorId: string; objectIds: string[]; viewedAt?: string }): Promise<void>;
  };
  streamSubscriptionService?: DurableStreamSubscriptionService;
  /**
   * Optional hook to enforce capability gate checks on feed routes.
   * When provided, SSE/WS connections and feed query/hydrate requests
   * will be rejected with 403 if the relevant capability is disabled.
   */
  capabilityGate?: (capabilityId: string) => CapabilityGateResult;
  /**
   * Optional hook to enforce per-plan connection limits on SSE/WS streams.
   * When provided, connections are rejected with 429 if over the plan limit.
   */
  checkStreamEntitlement?: (
    transport: "sse" | "websocket",
    currentCount: number,
  ) => StreamEntitlementResult;
}

const viewershipRecordBodySchema = z.object({
  viewerId: z.string().trim().min(1).max(2048),
  objectId: z.string().trim().min(1).max(2048).optional(),
  objectIds: z.array(z.string().trim().min(1).max(2048)).min(1).max(100).optional(),
  viewedAt: z.string().trim().min(1).max(64).optional(),
}).superRefine((value, ctx) => {
  const count = (value.objectId ? 1 : 0) + (value.objectIds?.length ?? 0);
  if (count < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "objectId or objectIds is required",
      path: ["objectId"],
    });
  }
});

export function registerFeedFastifyRoutes(app: FastifyInstance, deps: FeedFastifyRouteDeps): void {
  app.get("/internal/feed/definitions", async (req, reply) => {
    const start = Date.now();
    applyInternalResponseHeaders(reply);
    if (!isAuthorized(req, deps.sidecarToken)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "definitions", status: "unauthorized" });
      promMetrics.feedRequestLatency.observe({ endpoint: "definitions" }, (Date.now() - start) / 1000);
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!hasReadPermission(req)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "definitions", status: "forbidden" });
      promMetrics.feedRequestLatency.observe({ endpoint: "definitions" }, (Date.now() - start) / 1000);
      reply.code(403).send({ error: "forbidden", message: "Missing required permission: provider:read" });
      return;
    }

    const queryParse = listFeedsQuerySchema.safeParse(req.query ?? {});
    if (!queryParse.success) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "definitions", status: "invalid" });
      promMetrics.feedRequestLatency.observe({ endpoint: "definitions" }, (Date.now() - start) / 1000);
      reply.code(400).send({ error: "invalid_request" });
      return;
    }

    const { viewerId } = queryParse.data;
    const definitions = deps.feedService.listFeeds(viewerId);
    reply.send({
      generatedAt: new Date().toISOString(),
      definitions,
    });
    promMetrics.feedRequestsTotal.inc({ endpoint: "definitions", status: "success" });
    promMetrics.feedRequestLatency.observe({ endpoint: "definitions" }, (Date.now() - start) / 1000);
  });

  app.post("/internal/feed/query", async (req, reply) => {
    const start = Date.now();
    applyInternalResponseHeaders(reply);
    if (!isAuthorized(req, deps.sidecarToken)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "query", status: "unauthorized" });
      promMetrics.feedRequestLatency.observe({ endpoint: "query" }, (Date.now() - start) / 1000);
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!hasReadPermission(req)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "query", status: "forbidden" });
      promMetrics.feedRequestLatency.observe({ endpoint: "query" }, (Date.now() - start) / 1000);
      reply.code(403).send({ error: "forbidden", message: "Missing required permission: provider:read" });
      return;
    }

    const parsed = FeedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "query", status: "invalid" });
      promMetrics.feedRequestLatency.observe({ endpoint: "query" }, (Date.now() - start) / 1000);
      reply.code(400).send({ error: "invalid_request" });
      return;
    }

    try {
      const result = await deps.feedService.getFeed(parsed.data);
      let filteredItems = result.items;

      if (parsed.data.excludeViewed && parsed.data.viewerId && deps.viewershipHistoryClient && result.items.length > 0) {
        const candidates = collectFilterableObjectIds(result.items);
        if (candidates.length > 0) {
          try {
            const resolution = await deps.viewershipHistoryClient.resolveViewedObjectIds({
              actorId: parsed.data.viewerId,
              objectIds: candidates,
            });
            const viewed = new Set(resolution.viewedObjectIds);
            filteredItems = result.items.filter((item) => {
              const objectId = getFilterObjectId(item);
              return !objectId || !viewed.has(objectId);
            });
          } catch {
            // Fallback to unfiltered results when viewership lookup is unavailable.
            filteredItems = result.items;
          }
        }
      }

      reply.send({
        ...result,
        items: filteredItems,
      });
      promMetrics.feedRequestsTotal.inc({ endpoint: "query", status: "success" });
      promMetrics.feedRequestLatency.observe({ endpoint: "query" }, (Date.now() - start) / 1000);
    } catch (error) {
      if (error instanceof PodFeedServiceError) {
        promMetrics.feedRequestsTotal.inc({ endpoint: "query", status: "provider_error" });
        promMetrics.feedRequestLatency.observe({ endpoint: "query" }, (Date.now() - start) / 1000);
        reply.code(error.statusCode).send({
          error: error.code.toLowerCase(),
          message: error.message,
          retryable: error.retryable,
        });
        return;
      }

      promMetrics.feedRequestsTotal.inc({ endpoint: "query", status: "error" });
      promMetrics.feedRequestLatency.observe({ endpoint: "query" }, (Date.now() - start) / 1000);
      reply.code(500).send({ error: "internal_error" });
    }
  });

  app.post("/internal/feed/viewed", async (req, reply) => {
    const start = Date.now();
    applyInternalResponseHeaders(reply);
    if (!isAuthorized(req, deps.sidecarToken)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "viewed", status: "unauthorized" });
      promMetrics.feedRequestLatency.observe({ endpoint: "viewed" }, (Date.now() - start) / 1000);
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!hasPermission(req, "provider:write")) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "viewed", status: "forbidden" });
      promMetrics.feedRequestLatency.observe({ endpoint: "viewed" }, (Date.now() - start) / 1000);
      reply.code(403).send({ error: "forbidden", message: "Missing required permission: provider:write" });
      return;
    }

    if (!deps.viewershipHistoryClient) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "viewed", status: "not_configured" });
      promMetrics.feedRequestLatency.observe({ endpoint: "viewed" }, (Date.now() - start) / 1000);
      reply.code(501).send({ error: "not_implemented" });
      return;
    }

    const parsed = viewershipRecordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "viewed", status: "invalid" });
      promMetrics.feedRequestLatency.observe({ endpoint: "viewed" }, (Date.now() - start) / 1000);
      reply.code(400).send({ error: "invalid_request" });
      return;
    }

    const objectIds = dedupeObjectIds(parsed.data.objectId, parsed.data.objectIds);

    try {
      await deps.viewershipHistoryClient.recordView({
        actorId: parsed.data.viewerId,
        objectIds,
        viewedAt: parsed.data.viewedAt,
      });
      reply.code(202).send({ ok: true, recorded: objectIds.length });
      promMetrics.feedRequestsTotal.inc({ endpoint: "viewed", status: "success" });
      promMetrics.feedRequestLatency.observe({ endpoint: "viewed" }, (Date.now() - start) / 1000);
    } catch {
      promMetrics.feedRequestsTotal.inc({ endpoint: "viewed", status: "error" });
      promMetrics.feedRequestLatency.observe({ endpoint: "viewed" }, (Date.now() - start) / 1000);
      reply.code(502).send({ error: "upstream_error" });
    }
  });

  app.post("/internal/feed/hydrate", async (req, reply) => {
    const start = Date.now();
    applyInternalResponseHeaders(reply);
    if (!isAuthorized(req, deps.sidecarToken)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "hydrate", status: "unauthorized" });
      promMetrics.feedRequestLatency.observe({ endpoint: "hydrate" }, (Date.now() - start) / 1000);
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!hasReadPermission(req)) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "hydrate", status: "forbidden" });
      promMetrics.feedRequestLatency.observe({ endpoint: "hydrate" }, (Date.now() - start) / 1000);
      reply.code(403).send({ error: "forbidden", message: "Missing required permission: provider:read" });
      return;
    }

    const parsed = HydrationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      promMetrics.feedRequestsTotal.inc({ endpoint: "hydrate", status: "invalid" });
      promMetrics.feedRequestLatency.observe({ endpoint: "hydrate" }, (Date.now() - start) / 1000);
      reply.code(400).send({ error: "invalid_request" });
      return;
    }

    try {
      const result = await deps.hydrationService.hydrate(parsed.data);
      reply.send(result);
      if (result.omitted && result.omitted.length > 0) {
        for (const omitted of result.omitted) {
          promMetrics.feedHydrationOmissionsTotal.inc({ reason: omitted.reason });
        }
      }
      promMetrics.feedRequestsTotal.inc({ endpoint: "hydrate", status: "success" });
      promMetrics.feedRequestLatency.observe({ endpoint: "hydrate" }, (Date.now() - start) / 1000);
    } catch {
      promMetrics.feedRequestsTotal.inc({ endpoint: "hydrate", status: "error" });
      promMetrics.feedRequestLatency.observe({ endpoint: "hydrate" }, (Date.now() - start) / 1000);
      reply.code(500).send({ error: "internal_error" });
    }
  });

  // --------------------------------------------------------------------------
  // SSE: GET /internal/feed/stream
  // --------------------------------------------------------------------------
  app.get("/internal/feed/stream", async (req, reply) => {
    const svc = deps.streamSubscriptionService;
    if (!svc) {
      applyInternalResponseHeaders(reply);
      reply.code(501).send({ error: "not_implemented", message: "Stream subscriptions are not enabled" });
      return;
    }

    // Capability gate: reject if ap.feeds.realtime is disabled
    if (deps.capabilityGate) {
      const gate = deps.capabilityGate("ap.feeds.realtime");
      if (!gate.allowed) {
        applyInternalResponseHeaders(reply);
        promMetrics.capabilityGateTotal.inc({
          capability: "ap.feeds.realtime",
          outcome: `denied_${gate.reasonCode ?? "unknown"}`,
        });
        reply.code(403).send({
          error: gate.reasonCode ?? "feature_disabled",
          message: gate.message ?? "Realtime feed streams are not available on this provider",
          mode: "limited",
          contractRef: "realtime-disabled-v1",
          retryable: false,
        });
        return;
      }
      promMetrics.capabilityGateTotal.inc({ capability: "ap.feeds.realtime", outcome: "allowed" });
    }

    // Entitlement: enforce per-plan SSE connection limit
    if (deps.checkStreamEntitlement) {
      const currentSseCount = svc.getConnectionCountByTransport("sse");
      const check = deps.checkStreamEntitlement("sse", currentSseCount);
      if (!check.allowed) {
        applyInternalResponseHeaders(reply);
        reply.code(429).send({
          error: "limit_exceeded",
          message: `SSE connection plan limit (${check.effectiveLimit}) reached`,
          retryable: true,
        });
        return;
      }
    }

    let ctx;
    try {
      ctx = svc.authoriseRequest(
        normalizeStreamQuery(req.query as Record<string, unknown>),
        req.headers.authorization,
        req.headers["x-provider-permissions"] as string | undefined,
      );
    } catch (error) {
      applyInternalResponseHeaders(reply);
      if (error instanceof DurableStreamError) {
        promMetrics.feedStreamConnectionsTotal.inc({ transport: "sse", outcome: error.code });
        reply.code(error.statusCode).send({ error: error.code, message: error.message });
      } else {
        promMetrics.feedStreamConnectionsTotal.inc({ transport: "sse", outcome: "error" });
        reply.code(500).send({ error: "internal_error" });
      }
      return;
    }

    if (!svc.canAcceptConnection()) {
      applyInternalResponseHeaders(reply);
      promMetrics.feedStreamConnectionsTotal.inc({ transport: "sse", outcome: "capacity_exceeded" });
      reply.code(503).send({ error: "capacity_exceeded", message: "Stream connection limit reached", retryable: true });
      return;
    }

    promMetrics.feedStreamConnectionsTotal.inc({ transport: "sse", outcome: "accepted" });
    promMetrics.feedStreamActiveConnections.inc({ transport: "sse" });

    // Switch to SSE mode
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store, private",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
      "connection": "keep-alive",
    });

    // Emit opening comment so client knows streaming started
    reply.raw.write(": stream connected\n\n");

    const send = (event: string, data: string, id?: string): boolean => {
      if (reply.raw.destroyed) return false;
      try {
        if (id !== undefined) {
          reply.raw.write(`id: ${id}\n`);
        }
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${data}\n\n`);
        return true;
      } catch {
        return false;
      }
    };

    const close = (): void => {
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    };

    const cleanup = svc.registerSseConnection(ctx, send, close);

    req.raw.on("close", () => {
      cleanup();
      promMetrics.feedStreamActiveConnections.dec({ transport: "sse" });
    });

    req.raw.on("error", () => {
      cleanup();
      promMetrics.feedStreamActiveConnections.dec({ transport: "sse" });
    });

    // Keep the Fastify reply open (do not call reply.send)
    await new Promise<void>((resolve) => {
      req.raw.on("close", resolve);
      req.raw.on("error", resolve);
    });
  });
}

// ---------------------------------------------------------------------------
// Feed stream WebSocket handler — attached to the HTTP server after listen()
// This must be called AFTER app.listen() because app.server is set only then.
// ---------------------------------------------------------------------------
export function attachFeedStreamWebSocket(
  app: FastifyInstance,
  svc: DurableStreamSubscriptionService,
  options?: {
    maxConnections?: number;
    idleTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    capabilityGate?: (capabilityId: string) => CapabilityGateResult;
    checkStreamEntitlement?: (
      transport: "sse" | "websocket",
      currentCount: number,
    ) => StreamEntitlementResult;
  },
): void {
  const FEED_STREAM_PATH = "/internal/feed/stream/ws";
  const idleTimeoutMs = Math.min(Math.max(10_000, options?.idleTimeoutMs ?? 120_000), 300_000);
  const heartbeatIntervalMs = Math.min(
    Math.max(5_000, options?.heartbeatIntervalMs ?? 30_000),
    120_000,
  );

  const wss = new WebSocketServer({ noServer: true });
  const lastActivity = new WeakMap<WebSocket, number>();

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      const lastSeen = lastActivity.get(ws) ?? now;
      if (now - lastSeen > idleTimeoutMs) {
        ws.terminate();
        continue;
      }
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }
  }, heartbeatIntervalMs);

  heartbeatTimer.unref?.();

  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== FEED_STREAM_PATH) return;

    // Capability gate: reject if ap.feeds.realtime is disabled
    if (options?.capabilityGate) {
      const gate = options.capabilityGate("ap.feeds.realtime");
      if (!gate.allowed) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
            JSON.stringify({
              error: gate.reasonCode ?? "feature_disabled",
              message: gate.message ?? "Realtime feed streams are not available on this provider",
              mode: "limited",
              contractRef: "realtime-disabled-v1",
              retryable: false,
            }),
        );
        socket.destroy();
        promMetrics.feedStreamConnectionsTotal.inc({ transport: "websocket", outcome: "feature_disabled" });
        promMetrics.capabilityGateTotal.inc({
          capability: "ap.feeds.realtime",
          outcome: `denied_${gate.reasonCode ?? "unknown"}`,
        });
        return;
      }
      promMetrics.capabilityGateTotal.inc({ capability: "ap.feeds.realtime", outcome: "allowed" });
    }

    // Entitlement: enforce per-plan WebSocket connection limit
    if (options?.checkStreamEntitlement) {
      const currentWsCount = svc.getConnectionCountByTransport("websocket");
      const check = options.checkStreamEntitlement("websocket", currentWsCount);
      if (!check.allowed) {
        socket.write(
          "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
            JSON.stringify({
              error: "limit_exceeded",
              message: `WebSocket connection plan limit (${check.effectiveLimit}) reached`,
              retryable: true,
            }),
        );
        socket.destroy();
        promMetrics.feedStreamConnectionsTotal.inc({ transport: "websocket", outcome: "limit_exceeded" });
        return;
      }
    }

    // Capacity check before accepting upgrade
    if (!svc.canAcceptConnection()) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
          JSON.stringify({ error: "capacity_exceeded", message: "Stream connection limit reached", retryable: true }),
      );
      socket.destroy();
      promMetrics.feedStreamConnectionsTotal.inc({ transport: "websocket", outcome: "capacity_exceeded" });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      lastActivity.set(ws, Date.now());

      // Build query params from URL for authorisation
      const queryParams: Record<string, string | string[]> = {};
      for (const [key, value] of url.searchParams.entries()) {
        const existing = queryParams[key];
        if (existing === undefined) {
          queryParams[key] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          queryParams[key] = [existing, value];
        }
      }

      let ctx;
      try {
        ctx = svc.authoriseRequest(
          queryParams,
          req.headers.authorization,
          req.headers["x-provider-permissions"] as string | undefined,
        );
      } catch (error) {
        if (error instanceof DurableStreamError) {
          promMetrics.feedStreamConnectionsTotal.inc({ transport: "websocket", outcome: error.code });
          ws.close(1008, JSON.stringify({ error: error.code, message: error.message }));
        } else {
          promMetrics.feedStreamConnectionsTotal.inc({ transport: "websocket", outcome: "error" });
          ws.close(1011, JSON.stringify({ error: "internal_error" }));
        }
        return;
      }

      promMetrics.feedStreamConnectionsTotal.inc({ transport: "websocket", outcome: "accepted" });
      promMetrics.feedStreamActiveConnections.inc({ transport: "websocket" });

      const cleanup = svc.registerWsConnection(ctx, ws);

      ws.on("message", () => {
        lastActivity.set(ws, Date.now());
      });

      ws.on("pong", () => {
        lastActivity.set(ws, Date.now());
      });

      ws.on("close", () => {
        cleanup();
        promMetrics.feedStreamActiveConnections.dec({ transport: "websocket" });
      });

      ws.on("error", () => {
        cleanup();
        promMetrics.feedStreamActiveConnections.dec({ transport: "websocket" });
      });
    });
  });
}

/**
 * Normalize query parameters for stream subscriptions.
 * Fastify's default querystring parser represents repeated keys as arrays
 * only when the key appears multiple times. A single `streams=stream1`
 * will arrive as a string; wrap it so Zod sees a consistent array.
 */
function normalizeStreamQuery(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw };
  if (typeof result["streams"] === "string") {
    result["streams"] = [result["streams"]];
  }
  return result;
}

function isAuthorized(req: FastifyRequest, token: string): boolean {
  if (!token) {
    return false;
  }

  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const [scheme, suppliedToken] = header.split(" ");
  if (scheme !== "Bearer" || typeof suppliedToken !== "string") {
    return false;
  }

  return safeEqual(suppliedToken, token);
}

function hasReadPermission(req: FastifyRequest): boolean {
  return hasPermission(req, "provider:read");
}

function hasPermission(req: FastifyRequest, permission: string): boolean {
  const raw = typeof req.headers["x-provider-permissions"] === "string"
    ? req.headers["x-provider-permissions"]
    : "";
  return raw.split(",").map((value) => value.trim()).includes(permission);
}

function dedupeObjectIds(objectId?: string, objectIds?: string[]): string[] {
  const set = new Set<string>();
  if (typeof objectId === "string" && objectId.trim().length > 0) {
    set.add(objectId.trim());
  }
  for (const id of objectIds ?? []) {
    const trimmed = id.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
  return [...set];
}

function getFilterObjectId(item: { activityPubObjectId?: string; canonicalUri?: string }): string | undefined {
  if (typeof item.activityPubObjectId === "string" && item.activityPubObjectId.length > 0) {
    return item.activityPubObjectId;
  }
  if (typeof item.canonicalUri === "string" && item.canonicalUri.startsWith("http")) {
    return item.canonicalUri;
  }
  return undefined;
}

function collectFilterableObjectIds(items: Array<{ activityPubObjectId?: string; canonicalUri?: string }>): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const id = getFilterObjectId(item);
    if (id) set.add(id);
  }
  return [...set];
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function applyInternalResponseHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store, private");
  reply.header("pragma", "no-cache");
  reply.header("x-content-type-options", "nosniff");
}
