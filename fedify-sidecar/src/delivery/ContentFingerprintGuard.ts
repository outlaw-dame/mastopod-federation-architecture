/**
 * ContentFingerprintGuard
 *
 * Detects copy-paste spam by tracking content hashes across inbound activities.
 * When the same normalized content body is received from more than N distinct
 * actors within a rolling time window, it is flagged as a spam pattern.
 *
 * Storage: Redis sorted set keyed by content hash.
 *   - Member  = actorUri (deduplicates the same actor sending the same content)
 *   - Score   = Unix timestamp in ms (latest occurrence per actor)
 *
 * The time window is enforced at read time via ZCOUNT score range — no eager
 * pruning needed. The key TTL ensures the set expires naturally.
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

export interface ContentFingerprintStore {
  /**
   * Record that actorUri sent content with this hash, then return the number of
   * distinct actors who have sent the same content within the window.
   * Calling this multiple times for the same (hash, actorUri) pair only updates
   * the score — the distinct-actor count is never inflated by repeated sends.
   */
  recordAndCount(
    hash: string,
    actorUri: string,
    windowStartMs: number,
    ttlSeconds: number,
  ): Promise<number>;
}

export class ContentFingerprintGuard implements ContentFingerprintStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async recordAndCount(
    hash: string,
    actorUri: string,
    windowStartMs: number,
    ttlSeconds: number,
  ): Promise<number> {
    const key = `spam:cfp:${hash}`;
    const now = Date.now();

    await this.redis.zadd(key, now, actorUri);
    await this.redis.expire(key, ttlSeconds);

    return this.redis.zcount(key, windowStartMs, "+inf");
  }
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g;

/**
 * Normalize raw HTML or plain-text content into a stable string suitable for
 * fingerprinting. The goal is to make cosmetically-varied copies of the same
 * spam message produce the same hash.
 *
 * Steps:
 *   1. Strip HTML tags
 *   2. Decode common HTML entities
 *   3. Optionally replace URLs with a placeholder (catches link-varied templates)
 *   4. Lowercase + collapse whitespace
 */
export function normalizeContentForFingerprint(raw: string, normalizeUrls: boolean): string {
  let text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(ENTITY_PATTERN, (m) => HTML_ENTITIES[m] ?? m);

  if (normalizeUrls) {
    text = text.replace(/https?:\/\/\S+/g, "[URL]");
  }

  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeContentHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Extract a fingerprint-ready content string from an AP activity's object.
 * Returns null when the object carries no text body worth fingerprinting.
 */
export function extractActivityContent(activity: Record<string, unknown>): string | null {
  const obj = activity["object"];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  if (typeof o["content"] === "string" && o["content"].length > 0) {
    return o["content"] as string;
  }

  const cm = o["contentMap"];
  if (cm !== null && typeof cm === "object" && !Array.isArray(cm)) {
    const first = Object.values(cm as Record<string, unknown>).find((v) => typeof v === "string");
    if (typeof first === "string" && first.length > 0) return first;
  }

  if (typeof o["text"] === "string" && (o["text"] as string).length > 0) {
    return o["text"] as string;
  }

  return null;
}
