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
 *   GET  /users/:identifier/featured
 *   GET  /users/:identifier/featuredTags
 *   POST /.well-known/webfinger       (not used; omitted)
 *   POST /inbox                       (shared inbox, verified by Fedify)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FedifyFederationAdapter } from "./FedifyFederationAdapter.js";
import { injectBlockedProperty } from "./fep-c648/BlockedCollectionFastifyBridge.js";
import {
  buildActorStatusHistoryCollection,
  withActorStatusProperties,
} from "./fep-82f6/ActorStatusBridge.js";
import { withActorSearchConsentProperties } from "./fep-5feb-268d/ActorSearchConsentBridge.js";
import { withActorAuthorAttributionProperties } from "./fep-mastodon-author-attribution/ActorAuthorAttributionBridge.js";
import { logger } from "../utils/logger.js";

type SyndicationFormat = "rss" | "atom";
type SyndicationEntry = {
  id: string;
  url: string;
  title: string;
  summary?: string;
  publishedAt?: string;
};

const LOCAL_ACTOR_PATH_RE = /^\/users\/([a-zA-Z0-9._-]{1,128})$/;
const LOCAL_ACTOR_STATUS_HISTORY_RE = /^\/users\/([a-zA-Z0-9._-]{1,128})\/statusHistory$/;

// ---------------------------------------------------------------------------
// Internal bridge helper
// ---------------------------------------------------------------------------

function resolveExternalOrigin(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest
): string {
  const scheme = (request.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (request.headers["x-forwarded-host"] as string | undefined)
    ?? request.headers["host"]
    ?? adapter.buildContext().domain;

  return `${scheme}://${host}`;
}

async function fedifyHandler(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Build the full URL from Fastify's parsed pieces.
  const rawUrl = `${resolveExternalOrigin(adapter, request)}${request.url}`;

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
  let body = await response.text();

  // FEP-c648: inject `blocked` URL + context into actor document responses.
  const contentType = response.headers.get("content-type") ?? "";
  if (
    (contentType.includes("application/activity+json") ||
      contentType.includes("application/ld+json")) &&
    body.length > 0
  ) {
    const baseContext = adapter.buildContext();
    if (typeof baseContext.domain === "string" && baseContext.domain.length > 0) {
      body = injectBlockedProperty(request.url, body, baseContext.domain);
    }

    body = await maybeInjectActorStatus(adapter, request, body);

    // FEP-e3e9: expose the actor storage service endpoint on actor documents.
    const requestPath = request.url.split("?")[0] ?? request.url;
    if (request.method === "GET" && /^\/users\/[^/?]+$/.test(requestPath)) {
      const context = adapter.buildContext(request);
      if (typeof context.activityPodsUrl === "string" && context.activityPodsUrl.length > 0) {
        try {
          const actorUrl = `${resolveExternalOrigin(adapter, request)}${requestPath}`;
          body = withActorRelativeStorageService(actorUrl, JSON.parse(body), context.activityPodsUrl);
        } catch (err: unknown) {
          logger.warn(
            {
              url: request.url,
              error: err instanceof Error ? err.message : String(err),
            },
            "Failed to append actor-relative storage metadata",
          );
        }
      }
    }
  }

  reply.send(body);
}

function extractLocalIdentifier(path: string, pattern: RegExp): string | null {
  const match = pattern.exec(path);
  return match?.[1] ?? null;
}

async function fetchInternalJson(
  activityPodsUrl: string,
  activityPodsToken: string,
  path: string,
): Promise<{ status: number; body: unknown | null } | null> {
  try {
    const response = await fetch(`${activityPodsUrl.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/activity+json, application/ld+json, application/json",
        Authorization: `Bearer ${activityPodsToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  } catch {
    return null;
  }
}

async function maybeInjectActorStatus(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest,
  body: string,
): Promise<string> {
  const requestPath = request.url.split("?")[0] ?? request.url;
  const identifier = extractLocalIdentifier(requestPath, LOCAL_ACTOR_PATH_RE);
  if (request.method !== "GET" || !identifier) {
    return body;
  }

  const context = adapter.buildContext(request);
  if (
    typeof context.activityPodsUrl !== "string" ||
    context.activityPodsUrl.length === 0 ||
    typeof context.activityPodsToken !== "string" ||
    context.activityPodsToken.length === 0
  ) {
    return body;
  }

  const internalActor = await fetchInternalJson(
    context.activityPodsUrl,
    context.activityPodsToken,
    `/api/internal/actors/${encodeURIComponent(identifier)}`,
  );
  if (!internalActor) {
    logger.warn({ url: request.url }, "Failed to fetch internal actor status payload");
    return body;
  }
  if (internalActor.status === 404 || internalActor.body == null) {
    return body;
  }
  if (internalActor.status < 200 || internalActor.status >= 300) {
    logger.warn(
      {
        url: request.url,
        status: internalActor.status,
      },
      "Internal actor status fetch returned non-success status",
    );
    return body;
  }

  try {
    const actorUrl = `${resolveExternalOrigin(adapter, request)}${requestPath}`;
    const withSearchConsent = withActorSearchConsentProperties(JSON.parse(body), internalActor.body);
    const withAuthorAttribution = withActorAuthorAttributionProperties(JSON.parse(withSearchConsent), internalActor.body);
    return withActorStatusProperties(actorUrl, JSON.parse(withAuthorAttribution), internalActor.body);
  } catch (err: unknown) {
    logger.warn(
      {
        url: request.url,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to append actor status metadata",
    );
    return body;
  }
}

function hostMetaXml(origin: string): string {
  const template = `${origin}/.well-known/webfinger?resource={uri}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" type="application/jrd+json" template="${template}" />
</XRD>`;
}

function withActorRelativeStorageService(
  actorUrl: string,
  payload: unknown,
  storageEndpoint: string,
): string {
  if (!payload || typeof payload !== "object") {
    return JSON.stringify(payload);
  }

  const record = payload as Record<string, unknown>;
  const serviceRaw = record["service"];
  const currentServices = Array.isArray(serviceRaw) ? serviceRaw : [];
  const hasStorage = currentServices.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const id = (entry as Record<string, unknown>)["id"];
    return typeof id === "string" && id.endsWith("#storage");
  });

  if (hasStorage) {
    return JSON.stringify(record);
  }

  const normalizedEndpoint = storageEndpoint.replace(/\/+$/, "");
  const serviceEntry = {
    id: `${actorUrl}#storage`,
    type: "Service",
    serviceEndpoint: normalizedEndpoint,
  };

  return JSON.stringify({
    ...record,
    service: [...currentServices, serviceEntry],
  });
}

function concatServiceEndpoint(endpoint: string, relativeRef: string): string {
  const normalizedEndpoint = endpoint.replace(/\/+$/, "");
  const normalizedRef = relativeRef.startsWith("/") ? relativeRef : `/${relativeRef}`;
  return `${normalizedEndpoint}${normalizedRef}`;
}

function resolveStorageEndpointForService(
  actorDocument: unknown,
  actorId: string,
  serviceName: string,
): string | null {
  if (!actorDocument || typeof actorDocument !== "object") {
    return null;
  }

  const serviceRaw = (actorDocument as Record<string, unknown>)["service"];
  if (!Array.isArray(serviceRaw)) {
    return null;
  }

  const expectedSuffix = `#${serviceName}`;
  for (const entry of serviceRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const endpoint = record["serviceEndpoint"];

    if (typeof id !== "string" || typeof endpoint !== "string") {
      continue;
    }

    const idMatches = id === `${actorId}${expectedSuffix}` || id.endsWith(expectedSuffix);
    if (!idMatches) {
      continue;
    }

    try {
      return new URL(endpoint).toString();
    } catch {
      continue;
    }
  }

  return null;
}

async function maybeHandleActorRelativeRedirect(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const query = (request.query ?? {}) as { service?: string; relativeRef?: string };
  const service = typeof query.service === "string" ? query.service : undefined;
  const relativeRef = typeof query.relativeRef === "string" ? query.relativeRef : undefined;

  if (!service || !relativeRef) {
    return false;
  }

  const origin = resolveExternalOrigin(adapter, request);
  const actorUrl = `${origin}${request.url.split("?")[0]}`;
  const context = adapter.buildContext(request);

  let actorPayload: unknown = null;
  try {
    const federation = adapter.getFederation();
    const actorResponse = await federation.fetch(
      new Request(actorUrl, {
        method: "GET",
        headers: {
          Accept: "application/activity+json, application/ld+json, application/json",
        },
      }),
      { contextData: context },
    );

    if (!actorResponse.ok) {
      reply.status(actorResponse.status).send({ error: actorResponse.statusText || "Actor lookup failed" });
      return true;
    }

    actorPayload = await actorResponse.json().catch(() => null);
  } catch (err: unknown) {
    logger.warn(
      {
        url: actorUrl,
        error: err instanceof Error ? err.message : String(err),
      },
      "Actor-relative lookup failed",
    );
    reply.status(500).send({ error: "Actor-relative lookup failed" });
    return true;
  }

  const storageEndpoint = resolveStorageEndpointForService(actorPayload, actorUrl, service);
  const actorRecord = actorPayload && typeof actorPayload === "object"
    ? (actorPayload as Record<string, unknown>)
    : null;
  const actorService = actorRecord ? actorRecord["service"] : undefined;
  const hasExplicitInvalidServiceDefinition = actorRecord != null && Array.isArray(actorService);
  const fallbackStorageEndpoint =
    service === "storage" &&
    !hasExplicitInvalidServiceDefinition &&
    typeof context.activityPodsUrl === "string" &&
    context.activityPodsUrl.length > 0
      ? context.activityPodsUrl
      : null;

  const effectiveStorageEndpoint = storageEndpoint ?? fallbackStorageEndpoint;
  if (!effectiveStorageEndpoint) {
    reply.status(422).send({ error: "Missing or invalid actor service endpoint" });
    return true;
  }

  const location = concatServiceEndpoint(effectiveStorageEndpoint, relativeRef);
  reply.status(302).header("location", location).send();
  return true;
}

function hostMetaJson(origin: string): { links: Array<{ rel: string; type: string; template: string }> } {
  return {
    links: [
      {
        rel: "lrdd",
        type: "application/jrd+json",
        template: `${origin}/.well-known/webfinger?resource={uri}`,
      },
    ],
  };
}

function buildActorUriWebFinger(
  origin: string,
  resource: string | undefined
): { aliases: string[]; links: Array<{ rel: string; type: string; href: string }>; subject: string } | null {
  if (!resource) {
    return null;
  }

  let resourceUrl: URL;
  let originUrl: URL;

  try {
    resourceUrl = new URL(resource);
    originUrl = new URL(origin);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(resourceUrl.protocol)) {
    return null;
  }

  if (resourceUrl.hostname !== originUrl.hostname) {
    return null;
  }

  const actorMatch = /^\/users\/([^/]+)$/.exec(resourceUrl.pathname);
  if (!actorMatch) {
    return null;
  }

  return {
    subject: resource,
    aliases: [resource],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: resource,
      },
    ],
  };
}

function stripSyndicationSuffix(url: string): { basePathWithQuery: string; format: SyndicationFormat | null } {
  const atomMatch = url.match(/^(.*)\.atom(\?.*)?$/i);
  if (atomMatch) {
    return {
      basePathWithQuery: `${atomMatch[1] ?? ""}${atomMatch[2] ?? ""}`,
      format: "atom",
    };
  }

  const rssMatch = url.match(/^(.*)\.rss(\?.*)?$/i);
  if (rssMatch) {
    return {
      basePathWithQuery: `${rssMatch[1] ?? ""}${rssMatch[2] ?? ""}`,
      format: "rss",
    };
  }

  return { basePathWithQuery: url, format: null };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractFirstUrl(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstUrl(item);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fromId = extractFirstUrl(record["id"]);
    if (fromId) return fromId;
    return extractFirstUrl(record["url"]);
  }

  return null;
}

function toSyndicationEntries(payload: unknown, fallbackUrl: string): SyndicationEntry[] {
  const result: SyndicationEntry[] = [];
  const nowIso = new Date().toISOString();

  const pushEntry = (value: unknown): void => {
    if (typeof value === "string") {
      result.push({
        id: value,
        url: value,
        title: value,
      });
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const id = extractFirstUrl(record["id"]) ?? extractFirstUrl(record["url"]);
    if (!id) return;

    const title =
      (typeof record["name"] === "string" && record["name"].trim().length > 0
        ? record["name"]
        : null) ??
      (typeof record["summary"] === "string" && record["summary"].trim().length > 0
        ? record["summary"]
        : null) ??
      id;

    const summary =
      typeof record["summary"] === "string"
        ? record["summary"]
        : typeof record["content"] === "string"
          ? record["content"]
          : undefined;

    const publishedAt =
      typeof record["published"] === "string"
        ? record["published"]
        : typeof record["updated"] === "string"
          ? record["updated"]
          : undefined;

    result.push({
      id,
      url: extractFirstUrl(record["url"]) ?? id,
      title,
      summary,
      publishedAt,
    });
  };

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const collectionItems = record["orderedItems"] ?? record["items"];
    if (Array.isArray(collectionItems)) {
      for (const item of collectionItems.slice(0, 20)) {
        pushEntry(item);
      }
    } else {
      pushEntry(record);
    }
  }

  if (result.length === 0) {
    result.push({
      id: fallbackUrl,
      url: fallbackUrl,
      title: fallbackUrl,
      publishedAt: nowIso,
    });
  }

  return result;
}

function toRssXml(feedUrl: string, entries: SyndicationEntry[]): string {
  const now = new Date().toUTCString();
  const items = entries
    .map((entry) => {
      const pubDate = new Date(entry.publishedAt ?? Date.now()).toUTCString();
      const description = entry.summary ? `<description>${xmlEscape(entry.summary)}</description>` : "";
      return `<item>
  <title>${xmlEscape(entry.title)}</title>
  <link>${xmlEscape(entry.url)}</link>
  <guid>${xmlEscape(entry.id)}</guid>
  <pubDate>${xmlEscape(pubDate)}</pubDate>
  ${description}
</item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${xmlEscape(feedUrl)}</title>
  <link>${xmlEscape(feedUrl)}</link>
  <description>Fediverse syndication feed</description>
  <lastBuildDate>${xmlEscape(now)}</lastBuildDate>
${items}
</channel>
</rss>`;
}

function toAtomXml(feedUrl: string, entries: SyndicationEntry[]): string {
  const updated = entries[0]?.publishedAt ?? new Date().toISOString();
  const atomEntries = entries
    .map((entry) => {
      const entryUpdated = entry.publishedAt ?? updated;
      const summary = entry.summary ? `<summary>${xmlEscape(entry.summary)}</summary>` : "";
      return `<entry>
  <id>${xmlEscape(entry.id)}</id>
  <title>${xmlEscape(entry.title)}</title>
  <link href="${xmlEscape(entry.url)}" />
  <updated>${xmlEscape(entryUpdated)}</updated>
  ${summary}
</entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xmlEscape(feedUrl)}</id>
  <title>${xmlEscape(feedUrl)}</title>
  <updated>${xmlEscape(updated)}</updated>
  <link rel="self" href="${xmlEscape(feedUrl)}" />
${atomEntries}
</feed>`;
}

async function handleSyndicationRequest(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest,
  reply: FastifyReply,
  format: SyndicationFormat,
): Promise<void> {
  const origin = resolveExternalOrigin(adapter, request);
  const { basePathWithQuery } = stripSyndicationSuffix(request.url);
  const baseUrl = `${origin}${basePathWithQuery}`;
  let apPayload: unknown = null;

  try {
    const webRequest = new Request(baseUrl, {
      method: "GET",
      headers: {
        Accept: "application/activity+json, application/ld+json, application/json",
      },
    });
    const federation = adapter.getFederation();
    const fedifyResponse = await federation.fetch(webRequest, {
      contextData: adapter.buildContext(request),
    });

    if (fedifyResponse.ok) {
      apPayload = await fedifyResponse.json().catch(() => null);
    } else {
      logger.warn(
        {
          url: baseUrl,
          status: fedifyResponse.status,
        },
        "Syndication source returned non-success status; serving fallback feed",
      );
    }
  } catch (err: unknown) {
    logger.warn(
      {
        url: baseUrl,
        error: err instanceof Error ? err.message : String(err),
      },
      "Syndication source fetch failed; serving fallback feed",
    );
  }

  const entries = toSyndicationEntries(apPayload, baseUrl);
  if (format === "rss") {
    reply
      .status(200)
      .header("content-type", "application/rss+xml; charset=utf-8")
      .header("cache-control", "public, max-age=120")
      .send(toRssXml(baseUrl, entries));
    return;
  }

  reply
    .status(200)
    .header("content-type", "application/atom+xml; charset=utf-8")
    .header("cache-control", "public, max-age=120")
    .send(toAtomXml(baseUrl, entries));
}

async function handleActorStatusHistoryRequest(
  adapter: FedifyFederationAdapter,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const requestPath = request.url.split("?")[0] ?? request.url;
  const identifier = extractLocalIdentifier(requestPath, LOCAL_ACTOR_STATUS_HISTORY_RE);
  if (!identifier) {
    reply.status(404).send({ error: "Not Found" });
    return;
  }

  const context = adapter.buildContext(request);
  if (
    typeof context.activityPodsUrl !== "string" ||
    context.activityPodsUrl.length === 0 ||
    typeof context.activityPodsToken !== "string" ||
    context.activityPodsToken.length === 0
  ) {
    reply.status(503).send({ error: "Status history bridge unavailable" });
    return;
  }

  const internalHistory = await fetchInternalJson(
    context.activityPodsUrl,
    context.activityPodsToken,
    `/api/internal/actors/${encodeURIComponent(identifier)}/status-history`,
  );
  if (!internalHistory) {
    logger.warn({ url: request.url }, "Failed to fetch internal actor status history payload");
    reply.status(502).send({ error: "Status history lookup failed" });
    return;
  }
  if (internalHistory.status === 404) {
    reply.status(404).send({ error: "Not Found" });
    return;
  }
  if (internalHistory.status < 200 || internalHistory.status >= 300 || internalHistory.body == null) {
    logger.warn(
      {
        url: request.url,
        status: internalHistory.status,
      },
      "Internal actor status history fetch returned non-success status",
    );
    reply.status(502).send({ error: "Status history lookup failed" });
    return;
  }

  const origin = resolveExternalOrigin(adapter, request);
  const actorUrl = `${origin}/users/${identifier}`;
  const collectionUrl = `${actorUrl}/statusHistory`;
  const collection = buildActorStatusHistoryCollection(actorUrl, collectionUrl, internalHistory.body);

  reply
    .status(200)
    .header("content-type", "application/activity+json; charset=utf-8")
    .header("cache-control", "no-store")
    .send(collection);
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

  const hostMetaHandler = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = resolveExternalOrigin(adapter, req);
    reply
      .type("application/xrd+xml; charset=utf-8")
      .send(hostMetaXml(origin));
  };

  const hostMetaJsonHandler = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = resolveExternalOrigin(adapter, req);
    reply
      .type("application/jrd+json; charset=utf-8")
      .send(hostMetaJson(origin));
  };

  const webfingerHandler = (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { resource?: string | string[] } | undefined;
    const resource = Array.isArray(query?.resource) ? query?.resource[0] : query?.resource;
    const origin = resolveExternalOrigin(adapter, req);
    const actorUriWebFinger = buildActorUriWebFinger(origin, resource);
    if (actorUriWebFinger) {
      reply
        .type("application/jrd+json; charset=utf-8")
        .send(actorUriWebFinger);
      return;
    }

    return handler(req, reply);
  };

  app.get("/.well-known/host-meta", hostMetaHandler);
  app.get("/.well-known/host-meta.json", hostMetaJsonHandler);

  // WebFinger — required for Fediverse actor discovery
  app.get("/.well-known/webfinger", webfingerHandler);

  // NodeInfo — standard capability advertisement
  app.get("/.well-known/nodeinfo", handler);
  app.get("/nodeinfo/2.1", handler);

  // FEP-a5c5 Web Syndication Methods: append .rss / .atom to AP object URLs.
  app.get("/users/:identifier.rss", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "rss"),
  );
  app.get("/users/:identifier.atom", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "atom"),
  );
  app.get("/users/:identifier/outbox.rss", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "rss"),
  );
  app.get("/users/:identifier/outbox.atom", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "atom"),
  );
  app.get("/posts/:postId.rss", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "rss"),
  );
  app.get("/posts/:postId.atom", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "atom"),
  );
  app.get("/@:identifier(^[^/]+).rss", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "rss"),
  );
  app.get("/@:identifier(^[^/]+).atom", (req, reply) =>
    handleSyndicationRequest(adapter, req, reply, "atom"),
  );

  // Actor document + collections
  app.get("/users/:identifier/statusHistory", (req, reply) =>
    handleActorStatusHistoryRequest(adapter, req, reply),
  );
  app.get("/users/:identifier", async (req, reply) => {
    const redirected = await maybeHandleActorRelativeRedirect(adapter, req, reply);
    if (!redirected) {
      await handler(req, reply);
    }
  });
  app.get("/users/:identifier/outbox", handler);
  app.get("/users/:identifier/followers", handler);
  app.get("/users/:identifier/following", handler);
  app.get("/users/:identifier/featured", handler);
  app.get("/users/:identifier/featuredTags", handler);

  // Verified shared inbox ingress. Fedify validates signatures and routes
  // these requests before the sidecar persists them into Redis Streams.
  //
  // Per-actor inboxes remain on the sidecar-native verification path because
  // Fedify's actor-specific inbox flow expects locally available actor key
  // pairs for authenticated document loading, while ActivityPods is the sole
  // signing authority and private keys never leave it.
  app.post("/inbox", handler);
}
