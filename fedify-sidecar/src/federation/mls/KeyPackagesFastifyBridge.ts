import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { injectActorCollectionProperties } from "../ActorCollectionPropertyInjector.js";
import {
  fetchInternalActivityPodsBody,
  postInternalActivityPodsBody,
  IDENTIFIER_PATTERN,
  verifyOwnerHttpSignature,
} from "../OwnerScopedCollectionUtils.js";
import { logger } from "../../utils/logger.js";

const MLS_INTERNAL_GET_PATH = "/api/internal/mls-keys/key-packages";
const MLS_INTERNAL_SUBMIT_PATH = "/api/internal/mls-keys/submit";

// JSON-LD context URL for the AP E2EE MLS spec
// https://swicg.github.io/activitypub-e2ee/mls.html
const MLS_CONTEXT_URL = "https://purl.archive.org/socialweb/mls";

export interface KeyPackagesRouteOptions {
  activityPodsUrl: string;
  activityPodsToken: string;
  domain: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

// Base64 alphabet — only characters that can appear in an RFC 9420 encoded KeyPackage
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function getActorUri(domain: string, identifier: string): string {
  return `https://${domain}/users/${encodeURIComponent(identifier)}`;
}

function getKeyPackagesCollectionUri(domain: string, identifier: string): string {
  return `${getActorUri(domain, identifier)}/keyPackages`;
}

/**
 * Sanitize and project a single KeyPackage item from the internal API response.
 * Rejects items missing required fields; builds a stable item URI from the id.
 */
function sanitizeKeyPackageItem(
  item: unknown,
  domain: string,
  identifier: string,
  index: number,
): Record<string, unknown> | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;

  const id = typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : null;

  const cipherSuite =
    typeof raw["cipherSuite"] === "string" && raw["cipherSuite"].length > 0
      ? raw["cipherSuite"]
      : null;

  const publicBytes =
    typeof raw["publicBytes"] === "string" &&
    raw["publicBytes"].length > 0 &&
    BASE64_RE.test(raw["publicBytes"])
      ? raw["publicBytes"]
      : null;

  // Both fields are required to produce a valid KeyPackage item
  if (!cipherSuite || !publicBytes) return null;

  const collectionUri = getKeyPackagesCollectionUri(domain, identifier);
  const itemUri = id
    ? `${collectionUri}/${encodeURIComponent(id)}`
    : `${collectionUri}/${index}`;

  const sanitized: Record<string, unknown> = {
    type: "KeyPackage",
    id: itemUri,
    mediaType: "message/mls",
    encoding: "base64",
    content: publicBytes,
    cipherSuite,
  };

  if (typeof raw["createdAt"] === "string" && raw["createdAt"].length > 0) {
    sanitized["published"] = raw["createdAt"];
  }

  return sanitized;
}

function buildKeyPackagesCollection(
  identifier: string,
  domain: string,
  items: Record<string, unknown>[],
): Record<string, unknown> {
  const actorUri = getActorUri(domain, identifier);
  const collectionUri = getKeyPackagesCollectionUri(domain, identifier);

  return {
    "@context": ["https://www.w3.org/ns/activitystreams", MLS_CONTEXT_URL],
    type: "OrderedCollection",
    id: collectionUri,
    attributedTo: actorUri,
    totalItems: items.length,
    orderedItems: items,
  };
}

/**
 * Inject `mls:keyPackages` URL into actor documents fetched from Fedify.
 * Called in the FedifyFastifyBridge actor document response pipeline.
 */
export function injectKeyPackagesProperty(
  requestPath: string,
  body: string,
  domain: string,
): string {
  return injectActorCollectionProperties(
    requestPath,
    body,
    domain,
    [{ property: "keyPackages", suffix: "/keyPackages" }],
    [MLS_CONTEXT_URL],
  );
}

/**
 * Register GET /users/:identifier/keyPackages on the Fastify instance.
 *
 * Fetches the actor's active KeyPackages from ActivityPods (via the internal
 * mls-keys API) and serves them as an AP E2EE-compliant OrderedCollection.
 * The sidecar never sees plaintext message content; it only routes public
 * KeyPackage bytes.
 */
export function registerKeyPackagesRoutes(
  app: FastifyInstance,
  opts: KeyPackagesRouteOptions,
): void {
  const userAgent = opts.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const baseApUrl = opts.activityPodsUrl.replace(/\/$/, "");

  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/keyPackages",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;

      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      const url = `${baseApUrl}${MLS_INTERNAL_GET_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;

      const body = await fetchInternalActivityPodsBody<{ items?: unknown[] }>({
        label: "mls-key-packages",
        url,
        identifier,
        activityPodsToken: opts.activityPodsToken,
        timeoutMs,
      });

      const rawItems = Array.isArray(body?.items) ? body.items : [];
      const items: Record<string, unknown>[] = [];

      for (let i = 0; i < rawItems.length; i++) {
        const sanitized = sanitizeKeyPackageItem(rawItems[i], opts.domain, identifier, i);
        if (sanitized !== null) {
          items.push(sanitized);
        }
      }

      const collection = buildKeyPackagesCollection(identifier, opts.domain, items);

      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);

      logger.debug("[mls-key-packages] collection served", {
        identifier,
        itemCount: items.length,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /users/:identifier/keyPackages — owner-only (client-submitted keys)
  // Body: { type, mediaType, encoding, content, cipherSuite }
  // -------------------------------------------------------------------------
  app.post<{ Params: { identifier: string } }>(
    "/users/:identifier/keyPackages",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;

      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      const rawBodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});

      const authError = await verifyOwnerHttpSignature(
        req,
        identifier,
        opts.domain,
        userAgent,
        timeoutMs,
        rawBodyStr,
      );
      if (authError) {
        reply.status(authError.status).send({ error: authError.error });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        const parsed = rawBodyStr.length > 0 ? JSON.parse(rawBodyStr) : req.body;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reply.status(400).send({ error: "Request body must be a JSON object" });
          return;
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        reply.status(400).send({ error: "Invalid JSON body" });
        return;
      }

      const type = typeof payload["type"] === "string" ? payload["type"].trim() : "";
      const mediaType = typeof payload["mediaType"] === "string" ? payload["mediaType"].trim() : "";
      const encoding = typeof payload["encoding"] === "string" ? payload["encoding"].trim() : "";
      const content = typeof payload["content"] === "string" ? payload["content"].trim() : "";
      const cipherSuite = typeof payload["cipherSuite"] === "string" ? payload["cipherSuite"].trim() : "";

      if (type !== "KeyPackage") {
        reply.status(400).send({ error: 'type must be "KeyPackage"' });
        return;
      }
      if (mediaType !== "message/mls") {
        reply.status(400).send({ error: 'mediaType must be "message/mls"' });
        return;
      }
      if (encoding !== "base64") {
        reply.status(400).send({ error: 'encoding must be "base64"' });
        return;
      }
      if (!content || !BASE64_RE.test(content)) {
        reply.status(400).send({ error: "content must be non-empty valid base64" });
        return;
      }
      if (!cipherSuite) {
        reply.status(400).send({ error: "cipherSuite is required" });
        return;
      }

      const submitUrl = `${baseApUrl}${MLS_INTERNAL_SUBMIT_PATH}`;
      const result = await postInternalActivityPodsBody<{ id?: string; cipherSuite?: string }>({
        label: "mls-key-packages-submit",
        url: submitUrl,
        identifier,
        activityPodsToken: opts.activityPodsToken,
        timeoutMs,
        body: { actorIdentifier: identifier, cipherSuite, content },
      });

      if (result.statusCode === 400) {
        reply.status(400).send({ error: "Invalid key package payload" });
        return;
      }
      if (result.statusCode === 404) {
        reply.status(404).send({ error: "Actor not found" });
        return;
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        reply.status(502).send({ error: "Failed to store key package" });
        return;
      }

      logger.debug("[mls-key-packages] client key package stored", {
        identifier,
        cipherSuite,
        id: result.data?.id,
      });

      const collectionUri = getKeyPackagesCollectionUri(opts.domain, identifier);
      reply
        .status(201)
        .header("content-type", "application/activity+json")
        .send({
          "@context": ["https://www.w3.org/ns/activitystreams", MLS_CONTEXT_URL],
          type: "KeyPackage",
          id: result.data?.id ? `${collectionUri}/${encodeURIComponent(result.data.id)}` : undefined,
          cipherSuite: result.data?.cipherSuite ?? cipherSuite,
        });
    },
  );
}
