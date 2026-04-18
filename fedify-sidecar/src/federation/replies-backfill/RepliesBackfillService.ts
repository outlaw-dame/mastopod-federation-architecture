/**
 * Replies Backfill Service
 *
 * Implements Mastodon's conversation backfill convention:
 *
 *   1. Given a Note that carries a `replies` collection URI, paginate through
 *      the collection (following `next` links) and collect all reply URIs.
 *   2. For each reply URI, fetch the full object from the **origin server**
 *      (never trust inline bodies from the listing server — "origin is gospel").
 *   3. Enqueue the fetched reply objects as synthetic inbound AP envelopes so
 *      the normal inbound pipeline processes them.
 *   4. Recurse into each fetched reply's own `replies` collection up to the
 *      configured depth limit.
 *
 * Signing: requests are signed as the configured `signerActorUri` via the
 * shared `SigningClient` (keys remain in ActivityPods — identical pattern to
 * FollowersSyncService and FEP-8fcf fetch helpers).
 *
 * Deduplication: a per-URI cooldown is maintained in-memory (and optionally
 * in Redis) to avoid hammering origin servers when the same thread is viewed
 * concurrently by multiple local users.
 *
 * References:
 *   - https://github.com/mastodon/mastodon/pull/32615  (merged March 2025)
 *   - FEP-7458: replies collection advertisement (already done — sidecar
 *     projects `replies: "${objectId}/replies"` on all outbound Notes)
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import type { SigningClient } from "../../signing/signing-client.js";
import type { RedisStreamsQueue, InboundEnvelope } from "../../queue/sidecar-redis-queue.js";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Configuration
// ============================================================================

/** Duck-typed Redis interface; compatible with both ioredis and node-redis. */
export interface RepliesBackfillRedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exFlag: "EX", ttlSeconds: number): Promise<unknown>;
}

export interface RepliesBackfillConfig {
  /**
   * Actor URI used to sign authenticated GET requests to remote servers.
   * Typically the relay/service actor whose keys are held by ActivityPods.
   * Equivalent to Mastodon's `Account.representative`.
   */
  signerActorUri: string;

  /**
   * Maximum pages to follow per `replies` collection before stopping.
   * Prevents unbounded pagination on pathologically long threads.
   * Default: 5
   */
  maxPagesPerCollection?: number;

  /**
   * Maximum total reply URIs to fetch per root Note (across all recursion).
   * Prevents exponential work on viral threads.
   * Default: 100
   */
  maxRepliesPerThread?: number;

  /**
   * Maximum recursion depth into nested reply threads.
   * 0 = only top-level replies of the trigger note.
   * Default: 3
   */
  maxDepth?: number;

  /**
   * Per-URI cooldown (seconds): if we've fetched a given URI within this
   * window, skip it on the next trigger.
   * Default: 300 (5 min)
   */
  cooldownSeconds?: number;

  /** HTTP request timeout (ms). Default: 10 000 */
  requestTimeoutMs?: number;

  /** User-Agent string. */
  userAgent?: string;

  /** Optional Redis for cross-process deduplication cooldown. */
  redisCache?: RepliesBackfillRedisCache;
}

// ============================================================================
// Internal types
// ============================================================================

interface ResolvedConfig {
  signerActorUri: string;
  maxPagesPerCollection: number;
  maxRepliesPerThread: number;
  maxDepth: number;
  cooldownSeconds: number;
  requestTimeoutMs: number;
  userAgent: string;
}

// ============================================================================
// Service
// ============================================================================

export class RepliesBackfillService {
  private readonly signingClient: SigningClient;
  private readonly queue: RedisStreamsQueue;
  private readonly redis: RepliesBackfillRedisCache | null;
  private readonly cfg: ResolvedConfig;

  /** In-process cooldown cache (URI → expiry timestamp ms). */
  private readonly localCooldown = new Map<string, number>();

  constructor(
    signingClient: SigningClient,
    queue: RedisStreamsQueue,
    config: RepliesBackfillConfig,
  ) {
    this.signingClient = signingClient;
    this.queue = queue;
    this.redis = config.redisCache ?? null;
    this.cfg = {
      signerActorUri: config.signerActorUri,
      maxPagesPerCollection: config.maxPagesPerCollection ?? 5,
      maxRepliesPerThread: config.maxRepliesPerThread ?? 100,
      maxDepth: config.maxDepth ?? 3,
      cooldownSeconds: config.cooldownSeconds ?? 300,
      requestTimeoutMs: config.requestTimeoutMs ?? 10_000,
      userAgent: config.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)",
    };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Trigger a backfill from the `replies` collection advertised on `noteObject`.
   *
   * This is designed to be called **fire-and-forget**: it never throws — all
   * errors are logged and swallowed so the caller's normal activity path is
   * never affected.
   *
   * @param noteObject  The raw AP Note object (already deserialized JSON).
   */
  async triggerFromNote(noteObject: unknown): Promise<void> {
    try {
      const repliesUri = extractRepliesUri(noteObject);
      if (!repliesUri) return;

      const noteId = extractId(noteObject);
      logger.debug("[replies-backfill] triggering backfill", { noteId, repliesUri });

      // Counter shared across recursive calls to enforce thread-wide caps.
      const budget = { fetched: 0 };
      await this.backfillCollection(repliesUri, 0, budget);

      logger.debug("[replies-backfill] backfill complete", {
        noteId,
        totalFetched: budget.fetched,
      });
    } catch (err: any) {
      logger.warn("[replies-backfill] triggerFromNote error (swallowed)", {
        error: err.message,
      });
    }
  }

  // ==========================================================================
  // Core recursion
  // ==========================================================================

  private async backfillCollection(
    collectionUri: string,
    depth: number,
    budget: { fetched: number },
  ): Promise<void> {
    if (depth > this.cfg.maxDepth) {
      logger.debug("[replies-backfill] max depth reached, stopping", {
        collectionUri,
        depth,
      });
      return;
    }

    // Paginate the collection, collecting reply URIs.
    const replyUris = await this.paginateCollection(collectionUri);

    for (const replyUri of replyUris) {
      if (budget.fetched >= this.cfg.maxRepliesPerThread) {
        logger.debug("[replies-backfill] thread budget exhausted, stopping", {
          collectionUri,
          budget: budget.fetched,
        });
        return;
      }

      const onCooldown = await this.isOnCooldown(replyUri);
      if (onCooldown) {
        logger.debug("[replies-backfill] URI on cooldown, skipping", { replyUri });
        continue;
      }

      // Fetch from origin server.
      const replyObject = await this.fetchFromOrigin(replyUri);
      if (!replyObject) continue;

      await this.markCooldown(replyUri);
      budget.fetched++;

      // Enqueue as synthetic inbound envelope.
      await this.enqueueReply(replyObject, replyUri);

      // Recurse into this reply's own `replies` collection.
      const nestedRepliesUri = extractRepliesUri(replyObject);
      if (nestedRepliesUri) {
        await this.backfillCollection(nestedRepliesUri, depth + 1, budget);
      }
    }
  }

  // ==========================================================================
  // Collection pagination
  // ==========================================================================

  /**
   * Page through a `replies` collection and return all item URIs found.
   *
   * Per trwnh's recommendation and Mastodon's implementation:
   *   - prefer `orderedItems`, fallback to `items`
   *   - follow `first` → page objects → follow `next` links
   *   - stop when no `next` link or max-pages reached
   *   - do NOT rely on `type` field to identify collection vs page
   */
  private async paginateCollection(collectionUri: string): Promise<string[]> {
    const allUris: string[] = [];
    let pagesVisited = 0;

    try {
      // Step 1: fetch the collection document.
      const collectionDoc = await this.fetchJson(collectionUri);
      if (!collectionDoc) return allUris;

      // The collection document may contain items directly (FEP-7458 pattern)
      // or may point to a `first` page.
      const directItems = extractItems(collectionDoc);
      if (directItems.length > 0) {
        allUris.push(...directItems);
      }

      // Follow `first` → page chain.
      let nextUri = extractNextUri(collectionDoc, "first") ?? extractNextUri(collectionDoc, "next");

      while (nextUri && pagesVisited < this.cfg.maxPagesPerCollection) {
        const page = await this.fetchJson(nextUri);
        if (!page) break;

        pagesVisited++;
        const pageItems = extractItems(page);
        allUris.push(...pageItems);

        nextUri = extractNextUri(page, "next");
      }
    } catch (err: any) {
      logger.warn("[replies-backfill] paginateCollection error", {
        collectionUri,
        error: err.message,
      });
    }

    return allUris;
  }

  // ==========================================================================
  // Origin-server fetch
  // ==========================================================================

  /**
   * Fetch a single AP object from its origin server.
   *
   * "We always consult the origin server" — Mastodon convention.
   * The `replyUri` IS the origin, so we fetch it directly rather than
   * trusting anything inlined in the collection listing.
   */
  private async fetchFromOrigin(replyUri: string): Promise<Record<string, unknown> | null> {
    return this.fetchJson(replyUri);
  }

  // ==========================================================================
  // Signed JSON fetch
  // ==========================================================================

  private async fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const signResult = await this.signingClient.signOne({
        actorUri: this.cfg.signerActorUri,
        method: "GET",
        targetUrl: url,
      });

      if (!signResult.ok) {
        logger.warn("[replies-backfill] signing failed", {
          url,
          error: (signResult as { ok: false; error: { message: string } }).error.message,
        });
        return null;
      }

      const { date, signature } = signResult.signedHeaders;
      const parsedUrl = new URL(url);

      const resp = await request(url, {
        method: "GET",
        headers: {
          accept: "application/activity+json, application/ld+json",
          date,
          signature,
          host: parsedUrl.host,
          "user-agent": this.cfg.userAgent,
        },
        bodyTimeout: this.cfg.requestTimeoutMs,
        headersTimeout: this.cfg.requestTimeoutMs,
        maxRedirections: 2,
      });

      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        await resp.body.dump();
        logger.debug("[replies-backfill] non-OK response", {
          url,
          status: resp.statusCode,
        });
        return null;
      }

      const body = await resp.body.json() as Record<string, unknown>;
      return body;
    } catch (err: any) {
      logger.warn("[replies-backfill] fetchJson error", {
        url,
        error: err.message,
      });
      return null;
    }
  }

  // ==========================================================================
  // Enqueue as synthetic inbound
  // ==========================================================================

  /**
   * Wrap a fetched reply object in a synthetic `Create` activity and enqueue
   * it as an inbound envelope so normal ActivityPods forwarding happens.
   *
   * We synthesize the enclosing Create because ActivityPods' inbox processing
   * expects activities, not bare objects.
   */
  private async enqueueReply(
    object: Record<string, unknown>,
    objectUri: string,
  ): Promise<void> {
    try {
      const actorUri = extractAttributedTo(object);
      if (!actorUri) {
        logger.debug("[replies-backfill] no attributedTo, skipping enqueue", { objectUri });
        return;
      }

      // Determine local inbox path for this object. We target the shared inbox
      // so ActivityPods can route it to the appropriate pods.
      const inboxPath = "/inbox";

      const syntheticActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        id: `urn:backfill:${randomUUID()}`,
        actor: actorUri,
        object,
      };

      const body = JSON.stringify(syntheticActivity);

      const envelope: InboundEnvelope = {
        envelopeId: randomUUID(),
        method: "POST",
        path: inboxPath,
        headers: {
          "content-type": "application/activity+json",
          "x-backfill-source": "replies-collection",
        },
        body,
        remoteIp: "127.0.0.1",
        receivedAt: Date.now(),
        attempt: 0,
        notBeforeMs: 0,
        // Pre-verified: we fetched from origin server and trust the content.
        verification: {
          source: "fedify-v2",
          actorUri,
          verifiedAt: Date.now(),
        },
      };

      await this.queue.enqueueInbound(envelope);

      logger.debug("[replies-backfill] enqueued reply", {
        objectUri,
        actorUri,
        envelopeId: envelope.envelopeId,
      });
    } catch (err: any) {
      logger.warn("[replies-backfill] enqueueReply error (swallowed)", {
        objectUri,
        error: err.message,
      });
    }
  }

  // ==========================================================================
  // Cooldown tracking
  // ==========================================================================

  private async isOnCooldown(uri: string): Promise<boolean> {
    // In-process check first (fast path).
    const localExpiry = this.localCooldown.get(uri);
    if (localExpiry !== undefined && Date.now() < localExpiry) {
      return true;
    }

    // Redis check (cross-process deduplication).
    if (this.redis) {
      try {
        const key = `backfill:cooldown:${encodeURIComponent(uri)}`;
        const val = await this.redis.get(key);
        if (val !== null) return true;
      } catch {
        // Redis unavailable — fall through
      }
    }

    return false;
  }

  private async markCooldown(uri: string): Promise<void> {
    const expiryMs = Date.now() + this.cfg.cooldownSeconds * 1000;
    this.localCooldown.set(uri, expiryMs);

    // Prune the in-process map periodically to avoid unbounded growth.
    if (this.localCooldown.size > 10_000) {
      const now = Date.now();
      for (const [k, v] of this.localCooldown) {
        if (v < now) this.localCooldown.delete(k);
      }
    }

    if (this.redis) {
      try {
        const key = `backfill:cooldown:${encodeURIComponent(uri)}`;
        await this.redis.set(key, "1", "EX", this.cfg.cooldownSeconds);
      } catch {
        // Redis write failure is non-fatal
      }
    }
  }
}

// ============================================================================
// Pure helpers (exported for testability)
// ============================================================================

/** Extract the `replies` collection URI from an AP object. */
export function extractRepliesUri(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const r = (obj as Record<string, unknown>)["replies"];
  if (typeof r === "string" && r.length > 0) return r;
  // Compact-object form: { "id": "...", "type": "Collection" }
  if (typeof r === "object" && r !== null) {
    const id = (r as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** Extract `orderedItems` first, fallback to `items`. Returns URIs only. */
export function extractItems(doc: Record<string, unknown>): string[] {
  const raw = doc["orderedItems"] ?? doc["items"];
  if (!Array.isArray(raw)) return [];

  return raw.reduce<string[]>((acc, item) => {
    if (typeof item === "string" && item.length > 0) {
      acc.push(item);
    } else if (typeof item === "object" && item !== null) {
      const id = (item as Record<string, unknown>)["id"];
      if (typeof id === "string" && id.length > 0) {
        acc.push(id);
      }
    }
    return acc;
  }, []);
}

/**
 * Extract a URI from `first` or `next` property.
 *
 * Both may be a bare string or an object with an `id` field.
 */
export function extractNextUri(
  doc: Record<string, unknown>,
  key: "first" | "next",
): string | null {
  const val = doc[key];
  if (typeof val === "string" && val.length > 0) return val;
  if (typeof val === "object" && val !== null) {
    const id = (val as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** Extract the `id` field from an AP object. */
export function extractId(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const id = (obj as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : null;
}

/** Extract the actor URI from `attributedTo`. */
export function extractAttributedTo(obj: Record<string, unknown>): string | null {
  const at = obj["attributedTo"];
  if (typeof at === "string" && at.length > 0) return at;
  if (typeof at === "object" && at !== null) {
    const id = (at as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  // Some servers use `actor` on the outer object instead.
  const actor = obj["actor"];
  if (typeof actor === "string" && actor.length > 0) return actor;
  return null;
}
