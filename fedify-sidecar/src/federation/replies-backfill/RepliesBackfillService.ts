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

  /** Number of retries for transient fetch failures. Default: 3 */
  requestRetries?: number;

  /** Base delay for exponential backoff with jitter (ms). Default: 200 */
  requestRetryBaseDelayMs?: number;

  /** Maximum retry delay cap (ms). Default: 5000 */
  requestRetryMaxDelayMs?: number;

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
  requestRetries: number;
  requestRetryBaseDelayMs: number;
  requestRetryMaxDelayMs: number;
  userAgent: string;
}

type CollectionMode = "activities" | "posts";

const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_JSON_RESPONSE_BYTES = 2_000_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
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
      requestRetries: config.requestRetries ?? 3,
      requestRetryBaseDelayMs: config.requestRetryBaseDelayMs ?? 200,
      requestRetryMaxDelayMs: config.requestRetryMaxDelayMs ?? 5_000,
      userAgent: config.userAgent ?? "Fedify-Sidecar/5.0 (ActivityPods)",
    };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Trigger a backfill from an inbound activity carrying a Note/Article object.
   *
   * FEP-f228 retrieval order:
   *   1. `contextHistory` (collection of activities)
   *   2. `context`       (collection of posts)
   *   3. `replies`       (recursive fallback)
   */
  async triggerFromActivity(activity: unknown): Promise<void> {
    try {
      const activityRecord =
        typeof activity === "object" && activity !== null
          ? (activity as Record<string, unknown>)
          : null;
      const noteObject = extractNoteLikeObject(activity);
      if (!noteObject) {
        return;
      }

      const noteId = extractId(noteObject);

      const contextHistoryUri =
        extractContextHistoryUri(activityRecord) ?? extractContextHistoryUri(noteObject);
      if (contextHistoryUri) {
        const hydrated = await this.backfillFromCollection(contextHistoryUri, "activities");
        if (hydrated) {
          logger.debug("[replies-backfill] hydrated via contextHistory", {
            noteId,
            contextHistoryUri,
          });
          return;
        }
      }

      const contextUri =
        extractContextCollectionUri(activityRecord) ?? extractContextCollectionUri(noteObject);
      if (contextUri) {
        const contextCollectionDoc = await this.fetchJson(contextUri);
        if (contextCollectionDoc) {
          const historyUri = extractHistoryCollectionUri(contextCollectionDoc);
          if (historyUri) {
            const hydratedHistory = await this.backfillFromCollection(historyUri, "activities");
            if (hydratedHistory) {
              logger.debug("[replies-backfill] hydrated via context history pointer", {
                noteId,
                contextUri,
                historyUri,
              });
              return;
            }
          }
        }

        const hydrated = await this.backfillFromCollection(contextUri, "posts");
        if (hydrated) {
          logger.debug("[replies-backfill] hydrated via context collection", {
            noteId,
            contextUri,
          });
          return;
        }
      }

      const repliesUri = extractRepliesUri(noteObject);
      if (!repliesUri) return;

      logger.debug("[replies-backfill] triggering recursive replies fallback", {
        noteId,
        repliesUri,
      });

      const budget = { fetched: 0 };
      await this.backfillCollection(repliesUri, 0, budget);

      logger.debug("[replies-backfill] recursive replies fallback complete", {
        noteId,
        totalFetched: budget.fetched,
      });
    } catch (err: any) {
      logger.warn("[replies-backfill] triggerFromActivity error (swallowed)", {
        error: err.message,
      });
    }
  }

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
    await this.triggerFromActivity(noteObject);
  }

  private async backfillFromCollection(
    collectionUri: string,
    mode: CollectionMode,
  ): Promise<boolean> {
    const { uris, isCollectionLike } = await this.paginateCollection(collectionUri);
    if (!isCollectionLike) {
      logger.debug("[replies-backfill] URI did not resolve to collection", {
        collectionUri,
        mode,
      });
      return false;
    }

    if (uris.length === 0) {
      return true;
    }

    let hydratedCount = 0;
    for (const itemUri of uris) {
      if (hydratedCount >= this.cfg.maxRepliesPerThread) {
        break;
      }

      const onCooldown = await this.isOnCooldown(itemUri);
      if (onCooldown) continue;

      const item = await this.fetchJson(itemUri);
      if (!item) continue;

      await this.markCooldown(itemUri);

      const accepted =
        mode === "activities"
          ? await this.enqueueCollectionActivity(item, itemUri)
          : await this.enqueueCollectionPost(item, itemUri);

      if (accepted) {
        hydratedCount++;
      }
    }

    return true;
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
    const { uris: replyUris } = await this.paginateCollection(collectionUri);

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
  private async paginateCollection(
    collectionUri: string,
  ): Promise<{ uris: string[]; isCollectionLike: boolean }> {
    const allUris: string[] = [];
    let pagesVisited = 0;
    let isCollectionLike = false;

    try {
      // Step 1: fetch the collection document.
      const collectionDoc = await this.fetchJson(collectionUri);
      if (!collectionDoc) return { uris: allUris, isCollectionLike };
      isCollectionLike = looksLikeCollection(collectionDoc);

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
        if (looksLikeCollection(page)) {
          isCollectionLike = true;
        }

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

    return { uris: allUris, isCollectionLike };
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
    if (!isAllowedRemoteFetchUrl(url)) {
      logger.warn("[replies-backfill] blocked unsafe fetch URL", { url });
      return null;
    }

    const maxAttempts = Math.max(1, this.cfg.requestRetries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
          maxRedirections: 0,
        });

        const contentLengthHeader = resp.headers["content-length"];
        const contentLength =
          typeof contentLengthHeader === "string"
            ? Number.parseInt(contentLengthHeader, 10)
            : Array.isArray(contentLengthHeader)
              ? Number.parseInt(contentLengthHeader[0] ?? "", 10)
              : Number.NaN;

        if (Number.isFinite(contentLength) && contentLength > MAX_JSON_RESPONSE_BYTES) {
          await resp.body.dump();
          logger.warn("[replies-backfill] response exceeds size limit", {
            url,
            contentLength,
            maxBytes: MAX_JSON_RESPONSE_BYTES,
          });
          return null;
        }

        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          await resp.body.dump();

          if (
            TRANSIENT_HTTP_STATUS_CODES.has(resp.statusCode) &&
            attempt + 1 < maxAttempts
          ) {
            const delayMs = exponentialBackoffMs(
              attempt,
              this.cfg.requestRetryBaseDelayMs,
              this.cfg.requestRetryMaxDelayMs,
            );
            await sleep(delayMs);
            continue;
          }

          logger.debug("[replies-backfill] non-OK response", {
            url,
            status: resp.statusCode,
          });
          return null;
        }

        const body = await readJsonBodyWithLimit(resp.body, MAX_JSON_RESPONSE_BYTES);
        if (!body) {
          logger.debug("[replies-backfill] invalid JSON object payload", { url });
          return null;
        }
        return body;
      } catch (err: any) {
        if (attempt + 1 < maxAttempts) {
          const delayMs = exponentialBackoffMs(
            attempt,
            this.cfg.requestRetryBaseDelayMs,
            this.cfg.requestRetryMaxDelayMs,
          );
          await sleep(delayMs);
          continue;
        }

        logger.warn("[replies-backfill] fetchJson error", {
          url,
          error: err.message,
        });
        return null;
      }
    }

    return null;
  }

  private async enqueueCollectionActivity(
    activity: Record<string, unknown>,
    activityUri: string,
  ): Promise<boolean> {
    if (!isActivityLike(activity)) {
      return false;
    }

    const actorUri = extractActorUri(activity) ?? extractAttributedTo(activity);
    if (!actorUri) {
      logger.debug("[replies-backfill] activity missing actor, skipping", { activityUri });
      return false;
    }

    await this.enqueueSyntheticInbound(
      activity,
      actorUri,
      "context-history",
      activityUri,
    );
    return true;
  }

  private async enqueueCollectionPost(
    postOrActivity: Record<string, unknown>,
    objectUri: string,
  ): Promise<boolean> {
    if (isActivityLike(postOrActivity)) {
      return this.enqueueCollectionActivity(postOrActivity, objectUri);
    }

    const actorUri = extractAttributedTo(postOrActivity);
    if (!actorUri) {
      logger.debug("[replies-backfill] post missing attributedTo, skipping", { objectUri });
      return false;
    }

    const syntheticActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Create",
      id: `urn:backfill:${randomUUID()}`,
      actor: actorUri,
      object: postOrActivity,
    };

    await this.enqueueSyntheticInbound(
      syntheticActivity,
      actorUri,
      "context-collection",
      objectUri,
    );
    return true;
  }

  private async enqueueSyntheticInbound(
    activity: Record<string, unknown>,
    actorUri: string,
    source: string,
    sourceUri: string,
  ): Promise<void> {
    const envelope: InboundEnvelope = {
      envelopeId: randomUUID(),
      method: "POST",
      path: "/inbox",
      headers: {
        "content-type": "application/activity+json",
        "x-backfill-source": source,
      },
      body: JSON.stringify(activity),
      remoteIp: "127.0.0.1",
      receivedAt: Date.now(),
      attempt: 0,
      notBeforeMs: 0,
      verification: {
        source: "fedify-v2",
        actorUri,
        verifiedAt: Date.now(),
      },
    };

    await this.queue.enqueueInbound(envelope);
    logger.debug("[replies-backfill] enqueued synthetic activity", {
      source,
      sourceUri,
      envelopeId: envelope.envelopeId,
    });
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

      const syntheticActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        id: `urn:backfill:${randomUUID()}`,
        actor: actorUri,
        object,
      };
      await this.enqueueSyntheticInbound(
        syntheticActivity,
        actorUri,
        "replies-collection",
        objectUri,
      );
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

/** Extract `contextHistory` URI from an AP object/activity (string or object form). */
export function extractContextHistoryUri(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const candidates = [record["contextHistory"], record["as:contextHistory"]];

  for (const candidate of candidates) {
    const uri = extractUriLike(candidate);
    if (uri) return uri;
  }
  return null;
}

/** Extract `context` collection URI from an AP object/activity. */
export function extractContextCollectionUri(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const uri = extractUriLike(record["context"]);
  return uri;
}

/** Extract FEP-bad1 `history` collection URI from a context collection object. */
export function extractHistoryCollectionUri(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const candidates = [
    record["history"],
    record["as:history"],
    record["https://w3id.org/fep/bad1#history"],
  ];

  for (const candidate of candidates) {
    const uri = extractUriLike(candidate);
    if (uri) return uri;
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

function extractUriLike(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return isHttpUrl(value) ? value : null;
  }

  if (typeof value === "object" && value !== null) {
    const id = (value as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) {
      return isHttpUrl(id) ? id : null;
    }
  }

  return null;
}

function isHttpUrl(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAllowedRemoteFetchUrl(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;

    if (isPrivateIpLiteral(hostname)) return false;

    return true;
  } catch {
    return false;
  }
}

function isPrivateIpLiteral(hostname: string): boolean {
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }

  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (normalized === "::1") return true;
  if (normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;

  return false;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

async function readJsonBodyWithLimit(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of body) {
    const next = Buffer.from(chunk);
    totalBytes += next.byteLength;
    if (totalBytes > maxBytes) {
      return null;
    }
    chunks.push(next);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function looksLikeCollection(doc: Record<string, unknown>): boolean {
  const type = doc["type"];
  const typedAsCollection =
    typeof type === "string"
      ? type.includes("Collection")
      : Array.isArray(type)
        ? type.some((entry) => typeof entry === "string" && entry.includes("Collection"))
        : false;

  return (
    typedAsCollection ||
    Array.isArray(doc["orderedItems"]) ||
    Array.isArray(doc["items"]) ||
    doc["first"] !== undefined ||
    doc["next"] !== undefined
  );
}

function isActivityLike(record: Record<string, unknown>): boolean {
  const type = record["type"];
  if (typeof type !== "string") return false;

  return new Set([
    "Accept",
    "Add",
    "Announce",
    "Arrive",
    "Block",
    "Create",
    "Delete",
    "Dislike",
    "Flag",
    "Follow",
    "Ignore",
    "Invite",
    "Join",
    "Leave",
    "Like",
    "Listen",
    "Move",
    "Offer",
    "Question",
    "Read",
    "Reject",
    "Remove",
    "TentativeReject",
    "TentativeAccept",
    "Travel",
    "Undo",
    "Update",
    "View",
  ]).has(type);
}

function extractActorUri(record: Record<string, unknown>): string | null {
  const actor = record["actor"];
  if (typeof actor === "string" && actor.length > 0) return actor;
  if (typeof actor === "object" && actor !== null) {
    const id = (actor as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function extractNoteLikeObject(activity: unknown): Record<string, unknown> | null {
  if (typeof activity !== "object" || activity === null) return null;
  const act = activity as Record<string, unknown>;

  const type = act["type"];
  const noteTypes = new Set(["Note", "Article", "Page", "Question"]);
  if (typeof type === "string" && noteTypes.has(type)) {
    return act;
  }

  const wrappingTypes = new Set(["Create", "Update", "Announce"]);
  if (typeof type === "string" && wrappingTypes.has(type)) {
    const obj = act["object"];
    if (typeof obj === "object" && obj !== null) {
      const inner = obj as Record<string, unknown>;
      const innerType = inner["type"];
      if (typeof innerType === "string" && noteTypes.has(innerType)) {
        return inner;
      }
    }
  }

  return null;
}
