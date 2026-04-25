/**
 * RemoteSharedInboxCache
 *
 * Discovers and caches the `sharedInbox` endpoint advertised by remote
 * ActivityPub server actor documents, keyed at the domain level.
 *
 * ## Why domain-level caching
 *
 * `sharedInbox` is a server-level configuration: every actor on a given
 * ActivityPub server advertises the same sharedInbox URL in their actor
 * document.  Caching per domain means that, for a batch of 500 followers
 * spread across 20 remote servers, at most 20 HTTP fetches are made — and
 * zero after the cache warms up.
 *
 * ## Security
 *
 * - Only https: actor document URLs are fetched (never plain http).
 * - The resolved sharedInbox URL is validated to be a well-formed https: URL
 *   with no embedded credentials.
 * - Response bodies are capped at MAX_ACTOR_BODY_BYTES to prevent memory DOS.
 * - All fetch errors are swallowed and treated as "no sharedInbox", so the
 *   caller always falls back to per-inbox delivery.
 * - Domain names stored as SHA-256 digests so raw external hostnames never
 *   accumulate as plain-text cache keys.
 *
 * ## Thundering-herd mitigation
 *
 * Concurrent enrichment requests for different actors at the same domain all
 * hit the same cache key.  The first miss triggers one HTTP fetch; subsequent
 * concurrent misses for the same key also each trigger a fetch, but they all
 * write the same value.  The TTL ensures at most one thundering-herd event per
 * domain per 24 hours — acceptable given the infrequency of cold starts.
 *
 * Fetch concurrency across distinct domains is capped at MAX_CONCURRENT_FETCHES
 * to prevent overwhelming the outbox intent worker with open HTTP connections.
 */

import { createHash } from "node:crypto";
import { request } from "undici";
import pLimit from "p-limit";
import type { Redis } from "ioredis";
import { logger } from "../utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TTL_SECONDS = 24 * 3600;   // 24 h — matches Mastodon actor cache TTL
const FETCH_TIMEOUT_MS = 5_000;           // Per-request connect + body timeout
const MAX_ACTOR_BODY_BYTES = 64_000;      // Reject oversized actor documents
const MAX_CONCURRENT_FETCHES = 16;        // Cap HTTP fan-out per enrichment batch

// Sentinel stored in Redis when a domain is confirmed to have no sharedInbox.
// Empty string distinguishes "cached null" from "key not set".
const NULL_SENTINEL = "";

// ============================================================================
// RemoteSharedInboxCache
// ============================================================================

export class RemoteSharedInboxCache {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly userAgent: string;
  private readonly fetchLimit = pLimit(MAX_CONCURRENT_FETCHES);

  constructor(redis: Redis, userAgent: string, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.userAgent = userAgent;
  }

  /**
   * Enrich a list of outbound targets by resolving `sharedInbox` for any
   * target that does not already have one set.
   *
   * Enrichment runs concurrently (capped at MAX_CONCURRENT_FETCHES) and is
   * fully fault-isolated: any per-target failure silently falls back to the
   * original target, preserving per-inbox delivery as the safe default.
   *
   * Does NOT re-order targets. The caller must still deduplicate by
   * `deliveryUrl` after enrichment.
   */
  async enrichTargets<T extends { inboxUrl: string; sharedInboxUrl?: string; deliveryUrl: string; targetDomain: string }>(
    targets: T[],
  ): Promise<T[]> {
    return Promise.all(
      targets.map((target) => {
        if (target.sharedInboxUrl) return Promise.resolve(target);
        return this.fetchLimit(async () => {
          try {
            const sharedInbox = await this.resolveForDomain(target.targetDomain, target.inboxUrl);
            if (!sharedInbox) return target;
            return { ...target, sharedInboxUrl: sharedInbox, deliveryUrl: sharedInbox };
          } catch {
            // Non-blocking — enrichment failure preserves per-inbox delivery.
            return target;
          }
        });
      }),
    );
  }

  /**
   * Resolve the `sharedInbox` URL for a remote domain.
   *
   * Uses the `inboxUrl` hint to derive an actor document URL (by stripping the
   * `/inbox` suffix), then fetches and caches the result at domain granularity.
   *
   * Returns null when the domain has no sharedInbox, when the actor document
   * cannot be fetched, or when the inboxUrl does not follow the conventional
   * `/<path>/inbox` pattern.
   */
  async resolveForDomain(domain: string, inboxUrl: string): Promise<string | null> {
    const cacheKey = this.domainCacheKey(domain);

    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached === NULL_SENTINEL ? null : cached;
    }

    // Derive the actor document URL from the per-actor inbox URL.
    const actorUrl = deriveActorUrl(inboxUrl);
    if (!actorUrl) {
      // Cache the miss so we don't keep trying for this domain.
      await this.redis.set(cacheKey, NULL_SENTINEL, "EX", this.ttlSeconds);
      return null;
    }

    const sharedInbox = await this.fetchActorSharedInbox(actorUrl);
    await this.redis.set(cacheKey, sharedInbox ?? NULL_SENTINEL, "EX", this.ttlSeconds);

    if (sharedInbox) {
      logger.debug("[sharedInbox-cache] resolved", { domain, sharedInbox });
    }

    return sharedInbox;
  }

  /**
   * Explicitly invalidate the cached sharedInbox for a domain (e.g. after
   * repeated 404 / delivery failures that suggest the URL changed).
   */
  async invalidate(domain: string): Promise<void> {
    await this.redis.del(this.domainCacheKey(domain));
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private domainCacheKey(domain: string): string {
    const digest = createHash("sha256").update(domain.toLowerCase()).digest("hex");
    return `ap:shared-inbox:v1:${digest}`;
  }

  /**
   * Fetch the actor document at `actorUrl` and return its `sharedInbox` field.
   *
   * All errors (network, HTTP status, parse, validation) return null.
   * Response bodies exceeding MAX_ACTOR_BODY_BYTES are discarded.
   */
  private async fetchActorSharedInbox(actorUrl: string): Promise<string | null> {
    try {
      const { statusCode, body } = await request(actorUrl, {
        method: "GET",
        headers: {
          accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          "user-agent": this.userAgent,
        },
        bodyTimeout: FETCH_TIMEOUT_MS,
        headersTimeout: FETCH_TIMEOUT_MS,
        maxRedirections: 2,
      });

      if (statusCode < 200 || statusCode >= 300) {
        return null;
      }

      // Enforce response body size cap before JSON parsing.
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of body) {
        totalBytes += (chunk as Buffer).length;
        if (totalBytes > MAX_ACTOR_BODY_BYTES) {
          body.destroy();
          return null;
        }
        chunks.push(chunk as Buffer);
      }

      const doc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;

      const record = doc as Record<string, unknown>;
      const raw = record["sharedInbox"];
      if (typeof raw !== "string" || raw.trim().length === 0) return null;

      // Validate: must be well-formed https: URL with no embedded credentials.
      const parsed = new URL(raw.trim());
      if (parsed.protocol !== "https:") return null;
      if (parsed.username || parsed.password) return null;

      return parsed.toString();
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Module-level helper (pure, no I/O)
// ============================================================================

/**
 * Derive the actor document URL from a per-actor inbox URL by stripping the
 * trailing `/inbox` path segment.
 *
 * This covers the conventional pattern used by Mastodon, Pleroma, Misskey,
 * Akkoma, GoToSocial, and most other AP implementations:
 *   https://social.example.com/users/alice/inbox → https://social.example.com/users/alice
 *
 * Returns null when:
 * - The URL is not https: (never dereference remote http: documents).
 * - The pathname does not end in `/inbox`.
 * - The URL is malformed.
 *
 * Exported for testing.
 */
export function deriveActorUrl(inboxUrl: string): string | null {
  try {
    const parsed = new URL(inboxUrl);
    if (parsed.protocol !== "https:") return null;

    const path = parsed.pathname;
    if (!path.endsWith("/inbox")) return null;

    parsed.pathname = path.slice(0, -"/inbox".length) || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
