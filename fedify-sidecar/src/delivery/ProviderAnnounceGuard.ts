/**
 * ProviderAnnounceGuard
 *
 * Deduplicates Announce (boost) activities at the provider level by
 * (actorUri, objectId) within a rolling 24-hour window.
 *
 * ## Why a separate guard from InboundIdempotencyGuard
 *
 * InboundIdempotencyGuard deduplicates by activity ID.  A remote server may
 * deliver the same semantic boost (same actor, same boosted object) under
 * different activity IDs when:
 *   - retrying delivery to individual pod inboxes before sharedInbox collapses
 *   - generating a fresh activity wrapper on re-delivery
 *   - a relay re-announces an activity already received from the origin
 *
 * This guard adds a semantic-level layer: once (actorUri, objectId) has been
 * claimed, further Announce activities for that pair are suppressed even when
 * they carry a different activity ID.
 *
 * ## Redis key design
 *
 * Key:  ap:announce:v1:<sha256(actorUri + "::" + objectId)>
 * TTL:  24 h — a re-boost after 24 h is intentional and should pass through.
 *
 * ## Privacy
 *
 * SHA-256 digest means no plain-text URIs accumulate in Redis as cache keys,
 * consistent with the pattern used in InboundIdempotencyGuard and
 * RemoteSharedInboxCache.
 *
 * ## Atomicity
 *
 * Redis SET … NX is atomic — concurrent inbound workers racing on the same
 * (actor, object) pair will produce exactly one true return.
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

const DEFAULT_TTL_SECONDS = 24 * 3600;

export class ProviderAnnounceGuard {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Claim the (actorUri, objectId) pair as new.
   *
   * Returns true if this is the first Announce of this object by this actor
   * within the TTL window and the slot has been atomically claimed.
   * Returns false when the same semantic boost has already been processed
   * and should be suppressed.
   */
  async claimIfNew(actorUri: string, objectId: string): Promise<boolean> {
    const digest = createHash("sha256")
      .update(actorUri)
      .update("::")
      .update(objectId)
      .digest("hex");
    const key = `ap:announce:v1:${digest}`;
    const result = await this.redis.set(key, "1", "EX", this.ttlSeconds, "NX");
    return result === "OK";
  }
}
