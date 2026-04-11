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
  private buckets = new Map<string, Bucket>();

  consume(key: string, rule: RateLimitRule, nowMs = Date.now()): boolean {
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= nowMs) {
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
