/**
 * FedifyFastifyBridge
 *
 * Registers Fedify 2.x HTTP routes onto a Fastify server.
 *
 * Fedify exposes a standard web `fetch(Request): Promise<Response>` interface.
 * Fastify uses its own req/reply model. This bridge converts between the two.
 *
 * Routes registered (Fedify owns these; the rest stay with existing handlers):
 *   GET  /.well-known/webfinger
 *   GET  /.well-known/nodeinfo
 *   GET  /nodeinfo/2.1
 *   GET  /users/:identifier          (actor document — AP JSON-LD)
 *   GET  /users/:identifier/outbox
 *   GET  /users/:identifier/followers
 *   GET  /users/:identifier/following
 *
 * Inbox POST routes are NOT registered here — they remain in index.ts because
 * they enqueue to Redis Streams before any Fedify delegation occurs.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FedifyFederationAdapter } from "./FedifyFederationAdapter.js";

// ---------------------------------------------------------------------------
// Internal bridge helper
// ---------------------------------------------------------------------------

async function fedifyHandler(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Build the full URL from Fastify's parsed pieces.
  const scheme = (request.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (request.headers["x-forwarded-host"] as string | undefined)
    ?? request.headers["host"]
    ?? adapter.buildContext().domain;
  const rawUrl = `${scheme}://${host}${request.url}`;

  // Convert Fastify request → Web API Request.
  const init: RequestInit = {
    method: request.method,
    headers: request.headers as HeadersInit,
  };
  // Attach body for non-GET/HEAD requests.
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = request.body;
    init.body = typeof raw === "string" ? raw : JSON.stringify(raw);
  }

  const webRequest = new Request(rawUrl, init);
  const context = adapter.buildContext();
  const federation = adapter.getFederation();

  let response: Response;
  try {
    response = await federation.fetch(webRequest, context);
  } catch (err: unknown) {
    reply.status(500).send({ error: "Federation handler error" });
    return;
  }

  // 404 from Fedify means it deliberately didn't match — let Fastify fall
  // through to its own 404 handler. In practice this shouldn't happen for the
  // routes we explicitly registered, but it's the correct safety valve.
  if (response.status === 404) {
    reply.status(404).send({ error: "Not Found" });
    return;
  }

  // Forward status + headers.
  reply.status(response.status);
  response.headers.forEach((value: string, key: string) => {
    // Skip headers Fastify sets automatically.
    if (key.toLowerCase() === "content-length") return;
    reply.header(key, value);
  });

  // Stream or buffer the body.
  const body = await response.text();
  reply.send(body);
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

export function registerFedifyRoutes(
  app: FastifyInstance,
  adapter: FedifyFederationAdapter
): void {
  const handler = (req: FastifyRequest, reply: FastifyReply) =>
    fedifyHandler(adapter, req, reply);

  // WebFinger — required for Fediverse actor discovery
  app.get("/.well-known/webfinger", handler);

  // NodeInfo — standard capability advertisement
  app.get("/.well-known/nodeinfo", handler);
  app.get("/nodeinfo/2.1", handler);

  // Actor document + collections (GET only; POST inboxes stay in index.ts)
  app.get("/users/:identifier", handler);
  app.get("/users/:identifier/outbox", handler);
  app.get("/users/:identifier/followers", handler);
  app.get("/users/:identifier/following", handler);
}
