import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "./rate-limit.js";

describe("InMemoryRateLimiter", () => {
  it("prunes expired buckets before enforcing capacity", () => {
    const limiter = new InMemoryRateLimiter(2);
    const rule = { limit: 2, windowMs: 100 };

    expect(limiter.consume("a", rule, 0)).toBe(true);
    expect(limiter.consume("b", rule, 0)).toBe(true);

    // Once the earlier buckets have expired, a new key should not cause
    // the limiter to grow without bound or evict a still-live bucket.
    expect(limiter.consume("c", rule, 150)).toBe(true);
    expect(limiter.consume("c", rule, 150)).toBe(true);
    expect(limiter.consume("c", rule, 150)).toBe(false);
  });
});
