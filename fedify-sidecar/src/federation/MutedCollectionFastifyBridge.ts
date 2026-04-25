import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { injectActorCollectionProperties } from "./ActorCollectionPropertyInjector.js";
import {
  fetchInternalActivityPodsBody,
  IDENTIFIER_PATTERN,
  verifyOwnerHttpSignature,
} from "./OwnerScopedCollectionUtils.js";
import { logger } from "../utils/logger.js";

const MUTED_INTERNAL_PATH = "/api/internal/followers-sync/muted-collection";
const MUTED_FOLLOWERS_INTERNAL_PATH = "/api/internal/followers-sync/muted-followers-collection";
const MUTED_CONTEXT = {
  apods: "http://activitypods.org/ns/core#",
  muted: {
    "@id": "apods:muted",
    "@type": "@id",
  },
  mutedOf: {
    "@id": "apods:mutedOf",
    "@type": "@id",
  },
  subjectCanonicalId: "apods:subjectCanonicalId",
  subjectProtocol: "apods:subjectProtocol",
};

interface MutedCollectionProjection {
  items: unknown[];
  public: boolean;
  followersCollection: string | null;
}

export interface MutedCollectionRouteOptions {
  activityPodsUrl: string;
  activityPodsToken: string;
  domain: string;
  userAgent?: string;
  requestTimeoutMs?: number;
}

function getActorUri(domain: string, identifier: string): string {
  return `https://${domain}/users/${encodeURIComponent(identifier)}`;
}

function getMutedCollectionUri(domain: string, identifier: string): string {
  return `${getActorUri(domain, identifier)}/muted`;
}

function normalizeFollowerItems(items: unknown[]): string[] {
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

function isAbsoluteUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
}

function sanitizeMutedSubject(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const raw = item as Record<string, unknown>;
  const subjectCanonicalId = typeof raw["subjectCanonicalId"] === "string"
    ? raw["subjectCanonicalId"].trim()
    : "";
  const subjectProtocol = typeof raw["subjectProtocol"] === "string"
    ? raw["subjectProtocol"].trim().toLowerCase()
    : "";

  if (!subjectCanonicalId || !subjectProtocol) {
    return null;
  }

  const sanitized: Record<string, unknown> = {
    type: typeof raw["type"] === "string" ? raw["type"] : "Object",
    subjectCanonicalId,
    subjectProtocol,
  };

  const rawId = raw["id"] ?? raw["@id"];
  if (typeof rawId === "string" && isAbsoluteUri(rawId)) {
    sanitized["id"] = rawId;
  } else if (isAbsoluteUri(subjectCanonicalId)) {
    sanitized["id"] = subjectCanonicalId;
  }

  if (typeof raw["published"] === "string") {
    sanitized["published"] = raw["published"];
  }

  return sanitized;
}

function normalizeMutedSubjectItems(items: unknown[]): Record<string, unknown>[] {
  const ordered: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const sanitized = sanitizeMutedSubject(item);
    if (sanitized == null) {
      continue;
    }

    const subjectCanonicalId = sanitized["subjectCanonicalId"];
    const subjectProtocol = sanitized["subjectProtocol"];
    if (typeof subjectCanonicalId !== "string" || typeof subjectProtocol !== "string") {
      continue;
    }

    const dedupeKey = `${subjectProtocol}\u0000${subjectCanonicalId.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    ordered.push(sanitized);
  }

  return ordered;
}

function buildMutedCollectionResponse(
  identifier: string,
  domain: string,
  orderedItems: Record<string, unknown>[],
  isPublic: boolean,
): Record<string, unknown> {
  const actorUri = getActorUri(domain, identifier);
  const collectionUri = getMutedCollectionUri(domain, identifier);
  const collection: Record<string, unknown> = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      MUTED_CONTEXT,
    ],
    type: "OrderedCollection",
    id: collectionUri,
    attributedTo: actorUri,
    mutedOf: actorUri,
    totalItems: orderedItems.length,
    orderedItems,
  };

  if (isPublic) {
    collection["followers"] = `${collectionUri}/followers`;
  }

  return collection;
}

function buildMutedFollowersCollectionResponse(
  identifier: string,
  domain: string,
  items: string[],
): Record<string, unknown> {
  const actorUri = getActorUri(domain, identifier);
  const collectionUri = getMutedCollectionUri(domain, identifier);

  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      MUTED_CONTEXT,
    ],
    type: "Collection",
    id: `${collectionUri}/followers`,
    attributedTo: actorUri,
    totalItems: items.length,
    items,
  };
}

async function fetchMutedCollectionProjection(
  identifier: string,
  baseApUrl: string,
  activityPodsToken: string,
  timeoutMs: number,
): Promise<MutedCollectionProjection> {
  const url = `${baseApUrl}${MUTED_INTERNAL_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;
  const body = await fetchInternalActivityPodsBody<{
    items?: unknown[];
    public?: unknown;
    followersCollection?: unknown;
  }>({
    label: "muted",
    url,
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

async function fetchMutedFollowersProjection(
  identifier: string,
  baseApUrl: string,
  activityPodsToken: string,
  timeoutMs: number,
): Promise<MutedCollectionProjection> {
  const url = `${baseApUrl}${MUTED_FOLLOWERS_INTERNAL_PATH}?actorIdentifier=${encodeURIComponent(identifier)}`;
  const body = await fetchInternalActivityPodsBody<{
    items?: unknown[];
    public?: unknown;
    followersCollection?: unknown;
  }>({
    label: "muted-followers",
    url,
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

export function injectMutedProperty(
  requestPath: string,
  body: string,
  domain: string,
): string {
  return injectActorCollectionProperties(
    requestPath,
    body,
    domain,
    [{ property: "muted", suffix: "/muted" }],
    [MUTED_CONTEXT],
  );
}

export function registerMutedCollectionRoutes(
  app: FastifyInstance,
  opts: MutedCollectionRouteOptions,
): void {
  const userAgent = opts.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)";
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const baseApUrl = opts.activityPodsUrl.replace(/\/$/, "");

  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/muted/followers",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      const projection = await fetchMutedFollowersProjection(
        identifier,
        baseApUrl,
        opts.activityPodsToken,
        timeoutMs,
      );
      if (!projection.public) {
        reply.status(404).send({ error: "Muted followers collection not found" });
        return;
      }

      const items = normalizeFollowerItems(projection.items);
      const collection = buildMutedFollowersCollectionResponse(identifier, opts.domain, items);
      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);
    },
  );

  app.get<{ Params: { identifier: string } }>(
    "/users/:identifier/muted",
    async (
      req: FastifyRequest<{ Params: { identifier: string } }>,
      reply: FastifyReply,
    ) => {
      const { identifier } = req.params;
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        reply.status(400).send({ error: "Invalid actor identifier" });
        return;
      }

      const projection = await fetchMutedCollectionProjection(
        identifier,
        baseApUrl,
        opts.activityPodsToken,
        timeoutMs,
      );

      if (!projection.public) {
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

      const items = normalizeMutedSubjectItems(projection.items);
      const collection = buildMutedCollectionResponse(
        identifier,
        opts.domain,
        items,
        projection.public,
      );

      reply
        .status(200)
        .header("content-type", "application/activity+json")
        .send(collection);

      logger.debug("[muted-collection] collection served", {
        identifier,
        itemCount: items.length,
        public: projection.public,
      });
    },
  );
}
