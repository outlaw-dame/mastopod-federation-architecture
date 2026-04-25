import { tooMany } from "./errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export class InMemoryRateLimiter {
  private static readonly DEFAULT_MAX_BUCKETS = 10_000;
  private buckets = new Map<string, Bucket>();
  private consumeCount = 0;

  constructor(private readonly maxBuckets = InMemoryRateLimiter.DEFAULT_MAX_BUCKETS) {}

  private pruneExpired(nowMs: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= nowMs) {
        this.buckets.delete(key);
      }
    }
  }

  private evictOldestBucket(): void {
    let oldestKey: string | undefined;
    let oldestResetAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt < oldestResetAt) {
        oldestKey = key;
        oldestResetAt = bucket.resetAt;
      }
    }
    if (oldestKey) {
      this.buckets.delete(oldestKey);
    }
  }

  consume(key: string, rule: RateLimitRule, nowMs = Date.now()): boolean {
    this.consumeCount += 1;
    if (this.consumeCount % 256 === 0 || this.buckets.size >= this.maxBuckets) {
      this.pruneExpired(nowMs);
    }

    const current = this.buckets.get(key);

    if (!current || current.resetAt <= nowMs) {
      if (!current && this.buckets.size >= this.maxBuckets) {
        this.evictOldestBucket();
      }
      this.buckets.set(key, {
        count: 1,
        resetAt: nowMs + rule.windowMs,
      });
      return true;
    }

    if (current.count >= rule.limit) {
      return false;
    }

    current.count += 1;
    return true;
  }
}

export function assertRateLimit(
  limiter: InMemoryRateLimiter,
  key: string,
  rule: RateLimitRule,
): void {
  if (!limiter.consume(key, rule)) {
    throw tooMany("MRF admin rate limit exceeded");
  }
}
