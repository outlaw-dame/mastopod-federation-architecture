import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { RedisExternalAtModeGate } from "../ingress/RedisExternalAtModeGate.js";

let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 2000,
  });
  await redis.ping();
});
afterAll(async () => { if (redis) await redis.quit().catch(() => redis.disconnect()); });
const key = () => "at:external-mode-test:" + randomUUID().replace(/-/g, "");

describe("cross-replica ATProto ingestion mode admission", () => {
  it("admits multiple verified replicas but refuses an independent Jetstream deployment", async () => {
    const shared = key();
    const first = new RedisExternalAtModeGate(redis, shared, 800);
    const second = new RedisExternalAtModeGate(redis, shared, 800);
    const conflicting = new RedisExternalAtModeGate(redis, shared, 800);
    try {
      await first.start("verified", () => { throw Error("Unexpected fence loss"); });
      await second.start("verified", () => { throw Error("Unexpected fence loss"); });
      await expect(conflicting.start("jetstream-unverified", () => undefined))
        .rejects.toThrow(/Conflicting/);
      expect(await redis.get(shared)).toBe("verified");
    } finally { first.stop(); second.stop(); conflicting.stop(); }
    // A switch waits until the shared mode's TTL expires, even if one
    // replica exits without notifying the other.
    await expect(conflicting.start("jetstream-unverified", () => undefined))
      .rejects.toThrow(/Conflicting/);
    await new Promise(resolve => setTimeout(resolve, 950));
    await conflicting.start("jetstream-unverified", () => undefined);
    expect(await redis.get(shared)).toBe("jetstream-unverified");
    conflicting.stop();
  }, 5000);

  it("terminates admission on a mismatched mode rather than silently continuing", async () => {
    const shared = key(), lost = vi.fn();
    const mode = new RedisExternalAtModeGate(redis, shared, 600);
    try {
      await mode.start("verified", lost);
      await redis.set(shared, "jetstream-unverified", "PX", 600);
      const start = Date.now();
      while (lost.mock.calls.length === 0 && Date.now() - start < 1500) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(lost).toHaveBeenCalledTimes(1);
      expect(await redis.get(shared)).toBe("jetstream-unverified");
    } finally { mode.stop(); }
  });

  it("fails closed when the shared Redis admission authority becomes inaccessible", async () => {
    let attempts = 0;
    const redisDown = {
      eval: async () => {
        if (++attempts === 1) return 1;
        throw Error("Redis unreachable");
      },
    };
    const lost = vi.fn();
    const mode = new RedisExternalAtModeGate(redisDown, key(), 500);
    try {
      await mode.start("verified", lost);
      const start = Date.now();
      while (!lost.mock.calls.length && Date.now() - start < 1500) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(lost).toHaveBeenCalledTimes(1);
    } finally { mode.stop(); }
  });
});
