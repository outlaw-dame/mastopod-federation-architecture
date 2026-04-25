/**
 * InboundIdempotencyGuard
 *
 * Durable Redis-based idempotency guard for inbound ActivityPub activities.
 *
 * Uses SETNX (set-if-not-exists) with a configurable TTL to ensure each
 * activity ID is processed at most once, even across worker restarts or
 * during burst re-delivery from a remote server.
 *
 * Keys are hashed with SHA-256 so that arbitrarily long or unusual activity
 * IDs (relative URIs, opaque strings) never exceed Redis key-length limits.
 *
 * Security: activity IDs are not stored in plain text in Redis — only their
 * SHA-256 digests are persisted, which prevents leaking routing metadata.
 *
 * TTL defaults to 7 days (604 800 s) matching the Stream2/Firehose retention
 * window so that replayed events still within the log window are correctly
 * suppressed. Operators can tune this via the constructor parameter.
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

const DEFAULT_TTL_SECONDS = 7 * 24 * 3600; // 7 days

export class InboundIdempotencyGuard {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Attempt to atomically claim an activity ID as "seen".
   *
   * Returns `true`  — first claim; the caller SHOULD process this activity.
   * Returns `false` — already claimed; the caller MUST skip (duplicate).
   *
   * The operation is atomic: concurrent workers racing on the same activity ID
   * will result in exactly one `true` return.
   */
  async claimIfNew(activityId: string): Promise<boolean> {
    const digest = createHash("sha256").update(activityId).digest("hex");
    const key = `ap:ingress:v1:${digest}`;
    // ioredis v5: redis.set(key, value, "EX", ttlSeconds, "NX")
    // returns "OK" when the key was set (new), null when it already existed (dup).
    const result = await this.redis.set(key, "1", "EX", this.ttlSeconds, "NX");
    return result === "OK";
  }
}
