import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { metrics } from "../metrics/index.js";
import { parseCookieHeader, serializeCookie } from "./cookies.js";
import type { Fep3ab2ActivityPodsClient } from "./Fep3ab2ActivityPodsClient.js";
import { FepAuthorityClientError } from "./Fep3ab2ActivityPodsClient.js";
import type { Fep3ab2EventHub } from "./Fep3ab2EventHub.js";
import {
  Fep3ab2ReplayStore,
  parseReplayEventId,
} from "./Fep3ab2ReplayStore.js";
import {
  Fep3ab2SessionStore,
  FepSessionStoreError,
} from "./Fep3ab2SessionStore.js";
import {
  FepSubscriptionMutationSchema,
  FepSubscriptionTopicSchema,
  type FepControlSessionResponse,
  type FepSseEventName,
} from "./contracts.js";

export interface Fep3ab2RouteOptions {
  authorityClient: Fep3ab2ActivityPodsClient;
  sessionStore: Fep3ab2SessionStore;
  eventHub: Fep3ab2EventHub;
  replayStore: Fep3ab2ReplayStore;
  publicBaseUrl?: string;
  cookieName?: string;
  cookiePath?: string;
  cookieSameSite?: "Lax" | "Strict" | "None";
  cookieSecure?: boolean;
  cookieDomain?: string;
  allowedOrigins?: string[];
  maxStreamBufferBytes?: number;
}

export function registerFep3ab2Routes(app: FastifyInstance, options: Fep3ab2RouteOptions): void {
  const cookieName = options.cookieName ?? "ap_stream_ticket";
  const cookiePath = options.cookiePath ?? "/streaming";
  const cookieSameSite = options.cookieSameSite ?? "Lax";
  const cookieSecure = options.cookieSecure ?? process.env["NODE_ENV"] === "production";
  const allowedOrigins = new Set((options.allowedOrigins ?? []).filter(Boolean));
  const maxStreamBufferBytes = Math.max(
    65_536,
    Math.min(options.maxStreamBufferBytes ?? 1_048_576, 16_777_216),
  );

  registerOptionsRoute(app, "/streaming/control", allowedOrigins);
  registerOptionsRoute(app, "/streaming/control/subscriptions", allowedOrigins);
  registerOptionsRoute(app, "/streaming/stream", allowedOrigins);

  app.post("/streaming/control", async (request, reply) => {
    const origin = prepareJsonReply(request, reply, allowedOrigins);
    if (origin === false) {
      return;
    }

    const principal = await resolvePrincipal(request, reply, options.authorityClient);
    if (!principal) {
      return;
    }

    try {
      const session = await options.sessionStore.createSession({
        principal,
        origin: request.headers.origin,
        userAgent: request.headers["user-agent"],
      });

      const response: FepControlSessionResponse = {
        subscriptions_url: buildAbsoluteUrl(request, options.publicBaseUrl, "/streaming/control/subscriptions"),
        stream_url: buildAbsoluteUrl(request, options.publicBaseUrl, "/streaming/stream"),
        expires_at: session.expiresAt,
        wildcard_support: true,
      };

      reply.header("Set-Cookie", serializeCookie({
        name: cookieName,
        value: session.ticket,
        path: cookiePath,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        maxAge: options.sessionStore.ttlSeconds,
        domain: options.cookieDomain,
      }));
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "control_create", outcome: "success" });
      metrics.fepStreamingSessionsTotal.inc({ action: "created" });
      reply.code(201).send(response);
    } catch (error) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "control_create", outcome: "error" });
      handleSessionStoreError(reply, error);
    }
  });

  app.delete("/streaming/control", async (request, reply) => {
    const origin = prepareJsonReply(request, reply, allowedOrigins);
    if (origin === false) {
      return;
    }

    const principal = await resolvePrincipal(request, reply, options.authorityClient);
    if (!principal) {
      return;
    }

    const ticket = readTicketCookie(request.headers.cookie, cookieName);
    if (ticket) {
      try {
        await options.sessionStore.revokeByTicket(ticket, principal);
        metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "control_delete", outcome: "success" });
        metrics.fepStreamingSessionsTotal.inc({ action: "revoked" });
      } catch (error) {
        metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "control_delete", outcome: "error" });
        handleSessionStoreError(reply, error);
        return;
      }
    }

    reply.header("Set-Cookie", serializeCookie({
      name: cookieName,
      value: "",
      path: cookiePath,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      maxAge: 0,
      domain: options.cookieDomain,
    }));
    reply.code(204).send();
  });

  app.get("/streaming/control/subscriptions", async (request, reply) => {
    const origin = prepareJsonReply(request, reply, allowedOrigins);
    if (origin === false) {
      return;
    }

    const principal = await resolvePrincipal(request, reply, options.authorityClient);
    if (!principal) {
      return;
    }

    const session = await loadControlSession(request, reply, options.sessionStore, principal, cookieName);
    if (!session) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_list", outcome: "unauthorized" });
      return;
    }

    metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_list", outcome: "success" });
    reply.send({ topics: session.topics });
  });

  app.post("/streaming/control/subscriptions", async (request, reply) => {
    const origin = prepareJsonReply(request, reply, allowedOrigins);
    if (origin === false) {
      return;
    }

    const principal = await resolvePrincipal(request, reply, options.authorityClient);
    if (!principal) {
      return;
    }

    const session = await loadControlSession(request, reply, options.sessionStore, principal, cookieName);
    if (!session) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_add", outcome: "unauthorized" });
      return;
    }

    const parsed = FepSubscriptionMutationSchema.safeParse(request.body);
    if (!parsed.success) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_add", outcome: "invalid_request" });
      reply.code(400).send({
        error: "invalid_request",
        message: "topics must contain supported exact topics or bounded wildcard patterns",
      });
      return;
    }

    try {
      const authorization = await options.authorityClient.authorizeTopics(principal, parsed.data.topics);
      if (authorization.deniedTopics.length > 0 || authorization.allowedTopics.length !== parsed.data.topics.length) {
        metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_add", outcome: "forbidden" });
        reply.code(403).send({
          error: "topic_forbidden",
          deniedTopics: authorization.deniedTopics,
        });
        return;
      }

      const topics = await options.sessionStore.addTopics(session.sessionId, authorization.allowedTopics);
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_add", outcome: "success" });
      reply.send({ topics });
    } catch (error) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_add", outcome: "error" });
      handleAuthorityError(reply, error);
    }
  });

  app.delete("/streaming/control/subscriptions", async (request, reply) => {
    const origin = prepareJsonReply(request, reply, allowedOrigins);
    if (origin === false) {
      return;
    }

    const principal = await resolvePrincipal(request, reply, options.authorityClient);
    if (!principal) {
      return;
    }

    const session = await loadControlSession(request, reply, options.sessionStore, principal, cookieName);
    if (!session) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_delete", outcome: "unauthorized" });
      return;
    }

    const query = request.query as { topic?: string } | undefined;
    const parsedTopic = FepSubscriptionTopicSchema.safeParse(query?.topic);
    if (!parsedTopic.success) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_delete", outcome: "invalid_request" });
      reply.code(400).send({ error: "invalid_request", message: "topic query parameter is required" });
      return;
    }

    try {
      await options.sessionStore.removeTopic(session.sessionId, parsedTopic.data);
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_delete", outcome: "success" });
      reply.code(204).send();
    } catch (error) {
      metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "subscriptions_delete", outcome: "error" });
      handleSessionStoreError(reply, error);
    }
  });

  app.get("/streaming/stream", async (request, reply) => {
    const origin = enforceOriginPolicy(request, reply, allowedOrigins);
    if (origin === false) {
      return;
    }

    applyNoStoreHeaders(reply);
    if (typeof origin === "string") {
      applyCorsHeaders(reply, origin);
    } else if (allowedOrigins.size > 0) {
      reply.header("Vary", "Origin");
    }

    if (!acceptsEventStream(request)) {
      metrics.fepStreamingConnectionsTotal.inc({ outcome: "not_acceptable" });
      reply.code(406).send({ error: "not_acceptable", message: "Accept: text/event-stream is required" });
      return;
    }

    const ticket = readTicketCookie(request.headers.cookie, cookieName);
    if (!ticket) {
      metrics.fepStreamingConnectionsTotal.inc({ outcome: "invalid_ticket" });
      reply.code(401).send({ error: "invalid_ticket", message: "Streaming ticket cookie is required" });
      return;
    }

    const principal = await resolvePrincipal(request, reply, options.authorityClient);
    if (!principal) {
      metrics.fepStreamingConnectionsTotal.inc({ outcome: "login_required" });
      return;
    }

    let session;
    try {
      session = await options.sessionStore.consumeStreamTicket(ticket, {
        principal,
        origin: request.headers.origin,
        userAgent: request.headers["user-agent"],
      });
    } catch (error) {
      metrics.fepStreamingConnectionsTotal.inc({
        outcome: error instanceof FepSessionStoreError ? error.code : "internal_error",
      });
      handleSessionStoreError(reply, error);
      return;
    }

    const lastEventId = getLastEventId(request);
    const shouldReplay = parseReplayEventId(lastEventId) !== null;

    reply.raw.writeHead(200, buildStreamHeaders(origin, allowedOrigins));
    writeRawSseLine(reply, "retry: 3000\n");
    writeRawSseLine(reply, ": stream connected\n\n");

    const send = (event: FepSseEventName, data: string, id?: string): boolean => {
      if (
        reply.raw.destroyed ||
        reply.raw.writableEnded ||
        reply.raw.writableAborted ||
        reply.raw.writableLength > maxStreamBufferBytes
      ) {
        return false;
      }

      try {
        if (id) {
          reply.raw.write(`id: ${id}\n`);
        }
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${data}\n\n`);
        return !reply.raw.destroyed && !reply.raw.writableEnded && reply.raw.writableLength <= maxStreamBufferBytes;
      } catch {
        return false;
      }
    };

    const close = (): void => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    metrics.fepStreamingConnectionsTotal.inc({ outcome: "accepted" });
    const cleanup = options.eventHub.registerConnection({
      sessionId: session.sessionId,
      principal: session.principal,
      topics: session.topics,
      expiresAt: session.expiresAt,
      paused: shouldReplay,
      send,
      close,
    });

    const closePromise = new Promise<void>((resolve) => {
      const resolveOnce = (): void => resolve();
      request.raw.on("close", resolveOnce);
      request.raw.on("error", resolveOnce);
    });

    const onClose = (): void => {
      cleanup();
    };

    request.raw.on("close", onClose);
    request.raw.on("error", onClose);

    if (shouldReplay) {
      try {
        const replayedEvents = await options.replayStore.replayAfter(lastEventId, session.topics);
        metrics.fepStreamingReplayRequestsTotal.inc({
          outcome: replayedEvents.length > 0 ? "replayed" : "empty",
        });
        for (const event of replayedEvents) {
          const delivered = send(event.event, JSON.stringify(event.data), event.wireId);
          if (!delivered) {
            options.eventHub.closeSession(session.sessionId, "replay_send_failed");
            break;
          }
          metrics.fepStreamingReplayEventsTotal.inc({ action: "replayed" });
        }
      } catch (error) {
        metrics.fepStreamingReplayRequestsTotal.inc({ outcome: "error" });
        options.eventHub.closeSession(session.sessionId, "replay_failed");
      } finally {
        options.eventHub.resumeSession(session.sessionId);
      }
    } else if (lastEventId) {
      metrics.fepStreamingReplayRequestsTotal.inc({ outcome: "ignored_nonreplay_id" });
    }

    await closePromise;
  });
}

async function resolvePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  authorityClient: Fep3ab2ActivityPodsClient,
): Promise<string | null> {
  try {
    const resolved = await authorityClient.resolvePrincipal({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      userAgent: request.headers["user-agent"],
      xForwardedFor: typeof request.headers["x-forwarded-for"] === "string"
        ? request.headers["x-forwarded-for"]
        : undefined,
    });
    return resolved.principal;
  } catch (error) {
    handleAuthorityError(reply, error);
    return null;
  }
}

async function loadControlSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionStore: Fep3ab2SessionStore,
  principal: string,
  cookieName: string,
) {
  const ticket = readTicketCookie(request.headers.cookie, cookieName);
  if (!ticket) {
    reply.code(401).send({ error: "invalid_ticket", message: "Streaming ticket cookie is required" });
    return null;
  }

  try {
    return await sessionStore.loadControlSession(ticket, principal);
  } catch (error) {
    handleSessionStoreError(reply, error);
    return null;
  }
}

function registerOptionsRoute(
  app: FastifyInstance,
  path: string,
  allowedOrigins: ReadonlySet<string>,
): void {
  app.options(path, async (request, reply) => {
    const originAllowed = enforceOriginPolicy(request, reply, allowedOrigins);
    if (originAllowed === false) {
      return;
    }

    if (typeof originAllowed === "string") {
      applyCorsHeaders(reply, originAllowed);
    } else if (allowedOrigins.size > 0) {
      reply.header("Vary", "Origin");
    }

    reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Last-Event-ID");
    reply.code(204).send();
  });
}

function readTicketCookie(cookieHeader: string | undefined, cookieName: string): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  const ticket = cookies[cookieName];
  if (!ticket || ticket.length > 1_024) {
    return null;
  }
  return ticket;
}

function getLastEventId(request: FastifyRequest): string | undefined {
  const headerValue = request.headers["last-event-id"];
  if (typeof headerValue !== "string") {
    return undefined;
  }

  const normalized = headerValue.trim();
  if (!normalized || normalized.length > 512) {
    return undefined;
  }

  return normalized;
}

function acceptsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

function prepareJsonReply(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: ReadonlySet<string>,
): string | false | null {
  const origin = enforceOriginPolicy(request, reply, allowedOrigins);
  if (origin === false) {
    return false;
  }

  applyNoStoreHeaders(reply);
  if (typeof origin === "string") {
    applyCorsHeaders(reply, origin);
  } else if (allowedOrigins.size > 0) {
    reply.header("Vary", "Origin");
  }

  return origin;
}

function enforceOriginPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: ReadonlySet<string>,
): string | false | null {
  const origin = getAllowedOrigin(request, allowedOrigins);
  if (origin) {
    return origin;
  }

  const requestOrigin = request.headers.origin;
  if (allowedOrigins.size > 0 && typeof requestOrigin === "string" && requestOrigin.trim()) {
    reply.code(403).send({ error: "origin_forbidden", message: "Origin is not allowed for streaming access" });
    return false;
  }

  return null;
}

function getAllowedOrigin(
  request: FastifyRequest,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin.trim()) {
    return null;
  }

  if (allowedOrigins.size === 0) {
    return null;
  }

  return allowedOrigins.has(origin) ? origin : null;
}

function buildStreamHeaders(
  origin: string | null,
  allowedOrigins: ReadonlySet<string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-store, private",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  };

  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
    headers["vary"] = "Origin";
  } else if (allowedOrigins.size > 0) {
    headers["vary"] = "Origin";
  }

  return headers;
}

function applyCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Credentials", "true");
  reply.header("Vary", "Origin");
}

function applyNoStoreHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store, private");
  reply.header("Pragma", "no-cache");
  reply.header("X-Content-Type-Options", "nosniff");
}

function writeRawSseLine(reply: FastifyReply, data: string): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.write(data);
  }
}

function buildAbsoluteUrl(
  request: FastifyRequest,
  publicBaseUrl: string | undefined,
  path: string,
): string {
  if (publicBaseUrl) {
    return new URL(path, publicBaseUrl).toString();
  }

  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"].split(",")[0]?.trim()
    : undefined;
  const forwardedHost = typeof request.headers["x-forwarded-host"] === "string"
    ? request.headers["x-forwarded-host"].split(",")[0]?.trim()
    : undefined;
  const proto = forwardedProto || "http";
  const host = forwardedHost || request.headers.host || "localhost";
  return `${proto}://${host}${path}`;
}

function handleAuthorityError(reply: FastifyReply, error: unknown): void {
  if (error instanceof FepAuthorityClientError) {
    metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "authority", outcome: error.code });
    reply.code(error.statusCode >= 500 ? 502 : error.statusCode).send({
      error: error.code,
      message: error.message,
      retryable: error.retryable,
    });
    return;
  }

  metrics.fepStreamingControlRequestsTotal.inc({ endpoint: "authority", outcome: "internal_error" });
  reply.code(500).send({ error: "internal_error" });
}

function handleSessionStoreError(reply: FastifyReply, error: unknown): void {
  if (error instanceof FepSessionStoreError) {
    reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
      retryable: error.retryable,
    });
    return;
  }
  reply.code(500).send({ error: "internal_error" });
}
