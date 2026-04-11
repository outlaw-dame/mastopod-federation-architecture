import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  handleApplyDecision,
  handleGetDecision,
  handleListAtLabels,
  handleListDecisions,
  handleListKnownAtLabels,
  handleRevokeDecision,
  handleXrpcQueryLabels,
} from "./handlers.js";
import { errorToResponse } from "../mrf/utils.js";
import { assertRateLimit, InMemoryRateLimiter, type RateLimitRule } from "../mrf/rate-limit.js";
import type { ModerationBridgeDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Shared toRequest / sendResponse helpers
// (same pattern as admin/mrf/fastify-routes.ts)
// ---------------------------------------------------------------------------

function toRequest(req: FastifyRequest): Request {
  const protocolHeader = req.headers["x-forwarded-proto"];
  const protocol =
    typeof protocolHeader === "string" &&
    (protocolHeader === "http" || protocolHeader === "https")
      ? protocolHeader
      : "http";
  const hostHeader =
    typeof req.headers.host === "string" && req.headers.host.length > 0
      ? req.headers.host
      : "localhost";
  const url = `${protocol}://${hostHeader}${req.raw.url || "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }

  const body =
    req.body === undefined
      ? undefined
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

  return new Request(url, { method: req.method, headers, body });
}

async function sendResponse(reply: any, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    reply.header(key, value);
  });
  const text = await response.text();
  if (text.length === 0) {
    reply.send(undefined);
    return;
  }
  try {
    reply.send(JSON.parse(text));
  } catch {
    reply.send(text);
  }
}

function applyRateLimit(
  req: FastifyRequest,
  key: string,
  rule: RateLimitRule,
  limiter: InMemoryRateLimiter,
): void {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || "unknown";
  assertRateLimit(limiter, `${key}:${ip}`, rule);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerModerationBridgeFastifyRoutes(
  app: FastifyInstance,
  deps: ModerationBridgeDeps,
): void {
  const limiter = new InMemoryRateLimiter();

  // 30 applies per minute per IP
  const applyRule: RateLimitRule = { limit: 30, windowMs: 60_000 };
  // 120 reads per minute per IP
  const readRule: RateLimitRule = { limit: 120, windowMs: 60_000 };
  // 20 XRPC queries per minute per IP (public endpoint)
  const xrpcRule: RateLimitRule = { limit: 20, windowMs: 60_000 };

  // --------------------------------------------------------------------------
  // Internal admin endpoints (require bearer auth + X-Provider-Permissions)
  // --------------------------------------------------------------------------

  app.post("/internal/admin/moderation/decisions", async (req, reply) => {
    const request = toRequest(req);
    try {
      applyRateLimit(req, "moderation-apply", applyRule, limiter);
      await sendResponse(reply, await handleApplyDecision(request, deps));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });

  app.get("/internal/admin/moderation/decisions", async (req, reply) => {
    const request = toRequest(req);
    try {
      applyRateLimit(req, "moderation-list", readRule, limiter);
      await sendResponse(reply, await handleListDecisions(request, deps));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });

  app.get("/internal/admin/moderation/decisions/:id", async (req, reply) => {
    const request = toRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(req, "moderation-get", readRule, limiter);
      await sendResponse(reply, await handleGetDecision(request, deps, params.id));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });

  app.delete("/internal/admin/moderation/decisions/:id", async (req, reply) => {
    const request = toRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(req, "moderation-revoke", applyRule, limiter);
      await sendResponse(reply, await handleRevokeDecision(request, deps, params.id));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });

  app.get("/internal/admin/moderation/labels", async (req, reply) => {
    const request = toRequest(req);
    try {
      applyRateLimit(req, "moderation-labels", readRule, limiter);
      await sendResponse(reply, await handleListAtLabels(request, deps));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });

  app.get("/internal/admin/moderation/at-labels/known", async (req, reply) => {
    const request = toRequest(req);
    try {
      applyRateLimit(req, "moderation-known-labels", readRule, limiter);
      await sendResponse(reply, await handleListKnownAtLabels(request, deps));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });

  // --------------------------------------------------------------------------
  // Public AT Protocol XRPC endpoint
  // Bluesky clients call this to query labels from our labeler service.
  // https://atproto.com/lexicons/com-atproto-label#com-atproto-label-query-labels
  // --------------------------------------------------------------------------

  app.get("/xrpc/com.atproto.label.queryLabels", async (req, reply) => {
    const request = toRequest(req);
    try {
      applyRateLimit(req, "xrpc-query-labels", xrpcRule, limiter);
      await sendResponse(reply, await handleXrpcQueryLabels(request, deps));
    } catch (err) {
      await sendResponse(
        reply,
        errorToResponse(err, request.headers.get("x-request-id") || undefined),
      );
    }
  });
}
