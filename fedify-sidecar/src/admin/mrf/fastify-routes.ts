import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  handleCreateSimulation,
  handleGetChain,
  handleGetModule,
  handleGetRegistryItem,
  handleGetSimulation,
  handleGetMetrics,
  handleGetTraceDecisionChain,
  handleGetTraceSuggestions,
  handleGetTrace,
  handleListRegistry,
  handleListModules,
  handleListTraces,
  handlePatchChain,
  handlePatchModule,
} from "./handlers.js";
import { errorToResponse } from "./utils.js";
import { assertRateLimit, InMemoryRateLimiter, type RateLimitRule } from "./rate-limit.js";
import type { MRFAdminDeps } from "./types.js";
import {
  createEffectiveClientIpResolver,
  type EffectiveClientIpResolver,
} from "../../security/EffectiveClientIp.js";

export const MRF_EFFECTIVE_CLIENT_IP_HEADER = "x-sidecar-effective-client-ip";

function toRequest(req: FastifyRequest, effectiveClientIp: string): Request {
  const protocolHeader = req.headers["x-forwarded-proto"];
  const protocol = typeof protocolHeader === "string" && (protocolHeader === "http" || protocolHeader === "https")
    ? protocolHeader
    : "http";
  const hostHeader = typeof req.headers.host === "string" && req.headers.host.length > 0
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
  // This header is an internal adapter seam, not caller authority. Set it only
  // after copying request headers so an attacker-supplied value is overwritten.
  headers.set(MRF_EFFECTIVE_CLIENT_IP_HEADER, effectiveClientIp);

  const body = req.body === undefined
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
    reply.type(response.headers.get("content-type") || "text/plain; charset=utf-8");
    reply.send(text);
  }
}

export function registerMRFAdminFastifyRoutes(
  app: FastifyInstance,
  deps: MRFAdminDeps,
  options: { clientIpResolver?: EffectiveClientIpResolver } = {},
): void {
  const limiter = new InMemoryRateLimiter();
  const registryRule: RateLimitRule = { limit: 120, windowMs: 60_000 };
  const traceRule: RateLimitRule = { limit: 120, windowMs: 60_000 };
  const patchRule: RateLimitRule = { limit: 20, windowMs: 60_000 };
  const simulationRule: RateLimitRule = { limit: 5, windowMs: 60_000 };
  // Parse trusted-proxy configuration once during route registration. Invalid
  // configuration fails startup rather than silently trusting forwarded input.
  const resolveClientIp = options.clientIpResolver ?? createEffectiveClientIpResolver();

  const adaptRequest = (req: FastifyRequest): { request: Request; clientIp: string } => {
    const clientIp = resolveClientIp(req);
    return { request: toRequest(req, clientIp), clientIp };
  };

  const applyRateLimit = (clientIp: string, namespace: string, rule: RateLimitRule): void => {
    assertRateLimit(limiter, `${namespace}:${clientIp}`, rule);
  };

  app.get("/internal/admin/mrf/registry", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    try {
      applyRateLimit(clientIp, "list-registry", registryRule);
      await sendResponse(reply, await handleListRegistry(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/registry/:id", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(clientIp, "get-registry-item", registryRule);
      await sendResponse(reply, await handleGetRegistryItem(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/modules", async (req, reply) => {
    const { request } = adaptRequest(req);
    try {
      await sendResponse(reply, await handleListModules(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/modules/:id", async (req, reply) => {
    const { request } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      await sendResponse(reply, await handleGetModule(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.patch("/internal/admin/mrf/modules/:id", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(clientIp, "patch-module", patchRule);
      await sendResponse(reply, await handlePatchModule(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/chain", async (req, reply) => {
    const { request } = adaptRequest(req);
    try {
      await sendResponse(reply, await handleGetChain(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.patch("/internal/admin/mrf/chain", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    try {
      applyRateLimit(clientIp, "patch-chain", patchRule);
      await sendResponse(reply, await handlePatchChain(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/traces", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    try {
      applyRateLimit(clientIp, "list-traces", traceRule);
      await sendResponse(reply, await handleListTraces(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/traces/:id", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(clientIp, "get-trace", traceRule);
      await sendResponse(reply, await handleGetTrace(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/traces/:id/chain", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(clientIp, "get-trace-chain", traceRule);
      await sendResponse(reply, await handleGetTraceDecisionChain(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/traces/:id/suggestions", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(clientIp, "get-trace-suggestions", traceRule);
      await sendResponse(reply, await handleGetTraceSuggestions(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/metrics", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    try {
      applyRateLimit(clientIp, "get-metrics", traceRule);
      await sendResponse(reply, await handleGetMetrics(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.post("/internal/admin/mrf/simulations", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    try {
      applyRateLimit(clientIp, "create-simulation", simulationRule);
      await sendResponse(reply, await handleCreateSimulation(request, deps));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });

  app.get("/internal/admin/mrf/simulations/:id", async (req, reply) => {
    const { request, clientIp } = adaptRequest(req);
    const params = req.params as { id: string };
    try {
      applyRateLimit(clientIp, "get-simulation", simulationRule);
      await sendResponse(reply, await handleGetSimulation(request, deps, params.id));
    } catch (err) {
      await sendResponse(reply, errorToResponse(err, request.headers.get("x-request-id") || undefined));
    }
  });
}
