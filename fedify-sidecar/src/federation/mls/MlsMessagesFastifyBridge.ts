/**
 * AP E2EE MLS — Messages endpoints (sidecar side).
 *
 *   GET  /users/:identifier/messages
 *     Owner-only (HTTP Signature required, must be the collection owner).
 *     Returns an AS2 OrderedCollection of the actor's stored MLS messages,
 *     newest first. The sidecar never decrypts; it relays ciphertext only.
 *
 *   POST /users/:identifier/messages
 *     Accepted from any valid ActivityPub actor whose HTTP Signature verifies.
 *     Body: AP object with type, mediaType, encoding, and content fields.
 *     Forwards to ActivityPods internal /api/internal/mls-messages/deliver.
 *
 * Spec: https://swicg.github.io/activitypub-e2ee/mls.html
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { injectActorCollectionProperties } from "../ActorCollectionPropertyInjector.js";
import {
  fetchInternalActivityPodsBody,
  postInternalActivityPodsBody,
  IDENTIFIER_PATTERN,
  verifyOwnerHttpSignature,
  verifyAnyActorHttpSignature,
} from "../OwnerScopedCollectionUtils.js";
import { logger } from "../../utils/logger.js";

const MLS_MESSAGES_GET_PATH = "/api/internal/mls-messages/messages";
const MLS_MESSAGES_DELIVER_PATH = "/api/internal/mls-messages/deliver";
const MLS_CONTEXT_URL = "https://purl.archive.org/socialweb/mls";

const VALID_MLS_TYPES = new Set(["PublicMessage", "PrivateMessage", "Welcome", "GroupInfo"]);
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

export interface MlsMessagesRouteOptions {
  activityPodsUrl: string;
  activityPodsToken: string;
  domain: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

function getActorUri(domain: string, identifier: string): string {
  return `https://${domain}/users/${encodeURIComponent(identifier)}`;
}

function getMessagesCollectionUri(domain: string, identifier: string): string {
  return `${getActorUri(domain, identifier)}/messages`;
}

/**
 * Project a single stored message from the internal API into an AP object.
 * Rejects items missing required fields.
 */
function sanitizeMessageItem(
  item: unknown,
  domain: string,
  identifier: string,
  index: number,
): Record<string, unknown> | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;

  const id = typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : null;
  const type = typeof raw["type"] === "string" && VALID_MLS_TYPES.has(raw["type"]) ? raw["type"] : null;
  const senderUri = typeof raw["senderUri"] === "string" && raw["senderUri"].length > 0
    ? raw["senderUri"]
    : null;
  const content =
    typeof raw["content"] === "string" &&
    raw["content"].length > 0 &&
    BASE64_RE.test(raw["content"])
      ? raw["content"]
      : null;

  if (!type || !content) return null;

  const collectionUri = getMessagesCollectionUri(domain, identifier);
  const itemUri = id
    ? `${collectionUri}/${encodeURIComponent(id)}`
    : `${collectionUri}/${index}`;

  const sanitized: Record<string, unknown> = {
    type,
    id: itemUri,
    mediaType: "message/mls",
    encoding: "base64",
    content,
  };

  if (senderUri) sanitized["attributedTo"] = senderUri;

  if (typeof raw["publishedAt"] === "string" && raw["publishedAt"].length > 0) {
    sanitized["published"] = raw["publishedAt"];
  }

  return sanitized;
}

function buildMessagesCollection(
  identifier: string,
  domain: string,
  items: Record<string, unknown>[],
): Record<string, unknown> {
  const actorUri = getActorUri(domain, identifier);
  const collectionUri = getMessagesCollectionUri(domain, identifier);

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
 * Inject `mls:messages` URL into actor documents fetched from Fedify.
 * Called in the FedifyFastifyBridge actor document response pipeline.
 */
export function injectMessagesProperty(
  requestPath: string,
  body: string,
  domain: string,
): string {
  return injectActorCollectionProperties(
    requestPath,
    body,
    domain,
    [{ property: "messages", suffix: "/messages" }],
    [MLS_CONTEXT_URL],
  );
}

/**
 * Register GET and POST /users/:identifier/messages on the Fastify instance.
 * Must be registered before the Fedify catch-all.
 */
export function registerMlsMessagesRoutes(
  app: FastifyInstance,
  opts: MlsMessagesRouteOptions,
): void {
  const userAgent = opts.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const baseApUrl = opts.activityPodsUrl.replace(/\/$/, "");

  // -------------------------------------------------------------------------
  // GET /users/:identifier/messages — owner-only
  // -------------------------------------------------------------------------
  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/messages",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;

      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      const authError = await verifyOwnerHttpSignature(
        req,
        identifier,
        opts.domain,
        userAgent,
        timeoutMs,
      );
      if (authError) {
        reply.status(authError.status).send({ error: authError.error });
        return;
      }

      const url = `${baseApUrl}${MLS_MESSAGES_GET_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;
      const apBody = await fetchInternalActivityPodsBody<{ items?: unknown[] }>({
        label: "mls-messages",
        url,
        identifier,
        activityPodsToken: opts.activityPodsToken,
        timeoutMs,
      });

      const rawItems = Array.isArray(apBody?.items) ? apBody.items : [];
      const items: Record<string, unknown>[] = [];
      for (let i = 0; i < rawItems.length; i++) {
        const sanitized = sanitizeMessageItem(rawItems[i], opts.domain, identifier, i);
        if (sanitized !== null) items.push(sanitized);
      }

      const collection = buildMessagesCollection(identifier, opts.domain, items);

      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);

      logger.debug("[mls-messages] collection served", { identifier, itemCount: items.length });
    },
  );

  // -------------------------------------------------------------------------
  // POST /users/:identifier/messages — any valid AP actor
  // Body: { type, mediaType, encoding, content, [cipherSuite] }
  // -------------------------------------------------------------------------
  app.post<{ Params: { identifier: string } }>(
    "/users/:identifier/messages",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;

      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      // raw body is a string because Fastify is configured with parseAs:"string"
      const rawBodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});

      // Parse body first so we can use it for digest verification and field extraction
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

      const sigResult = await verifyAnyActorHttpSignature(
        req,
        rawBodyStr,
        userAgent,
        timeoutMs,
      );
      if (!sigResult.ok) {
        reply.status(sigResult.status).send({ error: sigResult.error });
        return;
      }
      const senderUri = sigResult.senderUri;

      const type = typeof payload["type"] === "string" ? payload["type"].trim() : "";
      const mediaType = typeof payload["mediaType"] === "string" ? payload["mediaType"].trim() : "";
      const encoding = typeof payload["encoding"] === "string" ? payload["encoding"].trim() : "";
      const content = typeof payload["content"] === "string" ? payload["content"].trim() : "";

      if (!VALID_MLS_TYPES.has(type)) {
        reply.status(400).send({
          error: `type must be one of: ${[...VALID_MLS_TYPES].join(", ")}`,
        });
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

      const deliverUrl = `${baseApUrl}${MLS_MESSAGES_DELIVER_PATH}`;
      const deliverBody: Record<string, unknown> = {
        actorIdentifier: identifier,
        senderUri,
        type,
        content,
      };
      if (typeof payload["id"] === "string" && payload["id"].length > 0) {
        deliverBody["externalId"] = payload["id"];
      }

      const result = await postInternalActivityPodsBody<{
        id?: string;
        type?: string;
        publishedAt?: string;
      }>({
        label: "mls-messages-deliver",
        url: deliverUrl,
        identifier,
        activityPodsToken: opts.activityPodsToken,
        timeoutMs,
        body: deliverBody,
      });

      if (result.statusCode === 400) {
        reply.status(400).send({ error: "Invalid message payload" });
        return;
      }
      if (result.statusCode === 404) {
        reply.status(404).send({ error: "Actor not found" });
        return;
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        reply.status(502).send({ error: "Failed to deliver message" });
        return;
      }

      logger.debug("[mls-messages] message delivered", {
        identifier,
        senderUri,
        type,
        messageId: result.data?.id,
      });

      reply
        .status(201)
        .header("content-type", "application/activity+json")
        .send({
          "@context": ["https://www.w3.org/ns/activitystreams", MLS_CONTEXT_URL],
          type,
          id: result.data?.id
            ? `${getMessagesCollectionUri(opts.domain, identifier)}/${encodeURIComponent(result.data.id)}`
            : undefined,
          published: result.data?.publishedAt,
        });
    },
  );
}
