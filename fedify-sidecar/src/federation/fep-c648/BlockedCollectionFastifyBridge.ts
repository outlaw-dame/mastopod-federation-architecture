/**
 * FEP-c648: Blocked Collection — Fastify bridge.
 *
 *   GET /users/:identifier/blocked
 *   GET /users/:identifier/blocked/followers
 *   GET /users/:identifier/blocks
 *
 * Per FEP-c648, each actor MAY expose `blocked` and/or `blocks`
 * OrderedCollections.  Both collections are private by default and accessible
 * only to the collection owner.
 *
 * This file provides two exports:
 *
 *   1. `injectBlockedProperty(requestPath, body, domain)`
 *      Injects the `blocked` and `blocks` URLs plus the FEP-c648 JSON-LD
 *      context term into an AP actor document body.  Called by
 *      FedifyFastifyBridge.fedifyHandler for actor document responses.
 *
 *   2. `registerBlockedCollectionRoutes(app, opts)`
 *      Serves the `blocked`, `blocked/followers`, and `blocks` collection
 *      routes. `blocks` always remains owner-only. `blocked` becomes
 *      anonymously readable and followable only when ActivityPods marks the
 *      blocked collection public; otherwise it remains owner-only.
 *
 * Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/c648/fep-c648.md
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { injectActorCollectionProperties } from "../ActorCollectionPropertyInjector.js";
import {
  fetchInternalActivityPodsBody,
  IDENTIFIER_PATTERN,
  verifyOwnerHttpSignature,
} from "../OwnerScopedCollectionUtils.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * The JSON-LD context URL for FEP-c648 (Blocked Collection).
 */
const FEP_C648_CONTEXT_URL = "https://purl.archive.org/socialweb/blocked";
const BLOCKED_INTERNAL_PATH = "/api/internal/followers-sync/blocked-collection";
const BLOCKED_FOLLOWERS_INTERNAL_PATH = "/api/internal/followers-sync/blocked-followers-collection";
const BLOCKS_INTERNAL_PATH = "/api/internal/followers-sync/blocks-collection";

// ============================================================================
// Actor document injection (called from FedifyFastifyBridge)
// ============================================================================

/**
 * Inject the `blocked`/`blocks` properties and FEP-c648 JSON-LD context into
 * an AP actor document body string.
 *
 * Only runs when `requestPath` (without query string) matches the actor
 * document route pattern `/users/:identifier`.  Returns the original `body`
 * unchanged in all other cases (non-actor path, non-JSON body, etc.).
 *
 * @param requestPath  The request URL path, e.g. "/users/alice" or "/users/alice?foo=bar"
 * @param body         The raw response body string from Fedify.
 * @param domain       The local domain, e.g. "example.com".
 */
export function injectBlockedProperty(
  requestPath: string,
  body: string,
  domain: string,
): string {
  return injectActorCollectionProperties(
    requestPath,
    body,
    domain,
    [
      { property: "blocked", suffix: "/blocked" },
      { property: "blocks", suffix: "/blocks" },
    ],
    [FEP_C648_CONTEXT_URL],
  );
}

type CollectionKind = "blocked" | "blocks";

interface BlockedCollectionProjection {
  items: unknown[];
  public: boolean;
  followersCollection: string | null;
}

function getActorUri(domain: string, identifier: string): string {
  return `https://${domain}/users/${encodeURIComponent(identifier)}`;
}

function getCollectionUri(domain: string, identifier: string, kind: CollectionKind): string {
  return `${getActorUri(domain, identifier)}/${kind}`;
}

function normalizeBlockedActorItems(items: unknown[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    let actorId: string | null = null;
    if (typeof item === "string") {
      actorId = item;
    } else if (item && typeof item === "object") {
      const rawId = (item as Record<string, unknown>)["id"] ?? (item as Record<string, unknown>)["@id"];
      if (typeof rawId === "string") {
        actorId = rawId;
      }
    }

    if (actorId == null || seen.has(actorId)) {
      continue;
    }

    seen.add(actorId);
    ordered.push(actorId);
  }

  return ordered;
}

function sanitizeBlockObject(
  value: unknown,
): string | Record<string, unknown> | null {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = raw["id"] ?? raw["@id"];
  if (typeof id !== "string") {
    return null;
  }

  const sanitized: Record<string, unknown> = { id };
  const type = raw["type"] ?? raw["@type"];
  if (typeof type === "string" || Array.isArray(type)) {
    sanitized["type"] = type;
  }
  if (typeof raw["name"] === "string") {
    sanitized["name"] = raw["name"];
  }

  return sanitized;
}

function sanitizeBlockActivity(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const raw = item as Record<string, unknown>;
  const id = raw["id"] ?? raw["@id"];
  if (typeof id !== "string") {
    return null;
  }

  const object = sanitizeBlockObject(raw["object"]);
  if (object == null) {
    return null;
  }

  const type = raw["type"] ?? raw["@type"] ?? "Block";
  const includesBlock = Array.isArray(type) ? type.includes("Block") : type === "Block";
  if (!includesBlock) {
    return null;
  }
  const sanitized: Record<string, unknown> = {
    id,
    type,
    object,
  };

  if (typeof raw["published"] === "string") {
    sanitized["published"] = raw["published"];
  }

  return sanitized;
}

function normalizeBlockActivityItems(items: unknown[]): Record<string, unknown>[] {
  const ordered: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const sanitized = sanitizeBlockActivity(item);
    if (sanitized == null) {
      continue;
    }

    const id = sanitized["id"];
    if (typeof id !== "string" || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ordered.push(sanitized);
  }

  return ordered;
}

function buildCollectionResponse(
  kind: CollectionKind,
  identifier: string,
  domain: string,
  orderedItems: unknown[],
  options: { publicBlocked?: boolean } = {},
): Record<string, unknown> {
  const actorUri = getActorUri(domain, identifier);
  const collection: Record<string, unknown> = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      FEP_C648_CONTEXT_URL,
    ],
    type: "OrderedCollection",
    id: getCollectionUri(domain, identifier, kind),
    attributedTo: actorUri,
    totalItems: orderedItems.length,
    orderedItems,
  };

  collection[kind === "blocked" ? "blockedOf" : "blocksOf"] = actorUri;
  if (kind === "blocked" && options.publicBlocked) {
    collection["followers"] = `${getCollectionUri(domain, identifier, "blocked")}/followers`;
  }
  return collection;
}

function buildBlockedFollowersCollectionResponse(
  identifier: string,
  domain: string,
  items: string[],
): Record<string, unknown> {
  const actorUri = getActorUri(domain, identifier);
  const blockedCollectionUri = getCollectionUri(domain, identifier, "blocked");

  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      FEP_C648_CONTEXT_URL,
    ],
    type: "Collection",
    id: `${blockedCollectionUri}/followers`,
    attributedTo: actorUri,
    totalItems: items.length,
    items,
  };
}

async function fetchBlockedCollectionProjection(
  identifier: string,
  baseApUrl: string,
  activityPodsToken: string,
  timeoutMs: number,
): Promise<BlockedCollectionProjection> {
  const apUrl = `${baseApUrl}${BLOCKED_INTERNAL_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;
  const body = await fetchInternalActivityPodsBody<{
    items?: unknown[];
    public?: unknown;
    followersCollection?: unknown;
  }>({
    label: "blocked",
    url: apUrl,
    identifier,
    activityPodsToken,
    timeoutMs,
  });

  return {
    items: Array.isArray(body?.items) ? body.items : [],
    public: body?.public === true,
    followersCollection: typeof body?.followersCollection === "string"
      ? body.followersCollection
      : null,
  };
}

async function fetchBlockActivityItems(
  identifier: string,
  baseApUrl: string,
  activityPodsToken: string,
  timeoutMs: number,
): Promise<unknown[]> {
  const apUrl = `${baseApUrl}${BLOCKS_INTERNAL_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;
  const body = await fetchInternalActivityPodsBody<{ items?: unknown[] }>({
    label: "blocks",
    url: apUrl,
    identifier,
    activityPodsToken,
    timeoutMs,
  });

  return Array.isArray(body?.items) ? body.items : [];
}

async function fetchBlockedFollowersItems(
  identifier: string,
  baseApUrl: string,
  activityPodsToken: string,
  timeoutMs: number,
): Promise<BlockedCollectionProjection> {
  const apUrl = `${baseApUrl}${BLOCKED_FOLLOWERS_INTERNAL_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;
  const body = await fetchInternalActivityPodsBody<{
    items?: unknown[];
    public?: unknown;
    followersCollection?: unknown;
  }>({
    label: "blocked-followers",
    url: apUrl,
    identifier,
    activityPodsToken,
    timeoutMs,
  });

  return {
    items: Array.isArray(body?.items) ? body.items : [],
    public: body?.public === true,
    followersCollection: typeof body?.followersCollection === "string"
      ? body.followersCollection
      : null,
  };
}

// ============================================================================
// Route registration
// ============================================================================

export interface BlockedCollectionRouteOptions {
  /** ActivityPods base URL, e.g. "http://activitypods:3000" */
  activityPodsUrl: string;
  /** Bearer token for the ActivityPods internal API */
  activityPodsToken: string;
  /** Local domain, e.g. "example.com" */
  domain: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

/**
 * Register the FEP-c648 collection routes on the Fastify instance.
 *
 * Must be registered BEFORE the Fedify catch-all route so it takes priority.
 */
export function registerBlockedCollectionRoutes(
  app: FastifyInstance,
  opts: BlockedCollectionRouteOptions,
): void {
  const userAgent = opts.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const baseApUrl = opts.activityPodsUrl.replace(/\/$/, "");

  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/blocked/followers",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;

      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      const projection = await fetchBlockedFollowersItems(
        identifier,
        baseApUrl,
        opts.activityPodsToken,
        timeoutMs,
      );
      if (!projection.public) {
        reply.status(404).send({ error: "Blocked followers collection not found" });
        return;
      }

      const followers = normalizeBlockedActorItems(projection.items);
      const collection = buildBlockedFollowersCollectionResponse(identifier, opts.domain, followers);

      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);
    },
  );

  const registerCollectionRoute = (kind: CollectionKind) => {
    app.get<{ Params: { identifier: string } }>(
      `/users/:identifier/${kind}`,
      async (
        req: FastifyRequest<{ Params: { identifier: string } }>,
        reply: FastifyReply,
      ) => {
        const { identifier } = req.params;

        // --- Input validation ---
        if (!IDENTIFIER_PATTERN.test(identifier)) {
          reply.status(400).send({ error: "Invalid actor identifier" });
          return;
        }

        const blockedProjection = kind === "blocked"
          ? await fetchBlockedCollectionProjection(
            identifier,
            baseApUrl,
            opts.activityPodsToken,
            timeoutMs,
          )
          : null;
        const isPublicBlockedCollection = blockedProjection?.public === true;

        if (!isPublicBlockedCollection) {
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
        }

        const rawItems = kind === "blocked"
          ? blockedProjection?.items ?? []
          : await fetchBlockActivityItems(
            identifier,
            baseApUrl,
            opts.activityPodsToken,
            timeoutMs,
          );
        const orderedItems = kind === "blocked"
          ? normalizeBlockedActorItems(rawItems)
          : normalizeBlockActivityItems(rawItems);
        const collection = buildCollectionResponse(
          kind,
          identifier,
          opts.domain,
          orderedItems,
          { publicBlocked: isPublicBlockedCollection },
        );

        reply
          .status(200)
          .header("content-type", "application/activity+json")
          .send(collection);

        logger.debug("[fep-c648] collection served", {
          kind,
          identifier,
          itemCount: orderedItems.length,
        });
      },
    );
  };

  registerCollectionRoute("blocked");
  registerCollectionRoute("blocks");
}
