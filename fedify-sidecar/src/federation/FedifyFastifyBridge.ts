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
 *   POST /.well-known/webfinger       (not used; omitted)
 *   POST /inbox                       (shared inbox, verified by Fedify)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FedifyFederationAdapter } from "./FedifyFederationAdapter.js";
import { logger } from "../utils/logger.js";

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
  const contextData = adapter.buildContext(request);
  const federation = adapter.getFederation();

  let response: Response;
  try {
    response = await federation.fetch(webRequest, { contextData });
  } catch (err: unknown) {
    logger.error(
      {
        method: request.method,
        url: rawUrl,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "Fedify bridge request failed",
    );
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

  // Actor document + collections
  app.get("/users/:identifier", handler);
  app.get("/users/:identifier/outbox", handler);
  app.get("/users/:identifier/followers", handler);
  app.get("/users/:identifier/following", handler);

  // Verified shared inbox ingress. Fedify validates signatures and routes
  // these requests before the sidecar persists them into Redis Streams.
  //
  // Per-actor inboxes remain on the sidecar-native verification path because
  // Fedify's actor-specific inbox flow expects locally available actor key
  // pairs for authenticated document loading, while ActivityPods is the sole
  // signing authority and private keys never leave it.
  app.post("/inbox", handler);
}
