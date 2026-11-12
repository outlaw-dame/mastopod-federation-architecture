import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { RedisAtFirehoseSourceFence, FirehoseFenceError } from "../ingress/RedisAtFirehoseSourceFence.js";

let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  await redis.ping();
});
afterAll(async () => { if (redis) await redis.quit().catch(() => redis.disconnect()); });

const unique = () => "fence-test:" + randomUUID();

describe("Redis-backed external Sync source ownership and monotonic cursors", () => {
  it("admits exactly one of concurrent replicas and fences stale lease tokens", async () => {
    const source = unique(), a = new RedisAtFirehoseSourceFence(redis, 1500);
    const b = new RedisAtFirehoseSourceFence(redis, 1500);
    const attempts = await Promise.all(Array.from({length: 12}, () =>
      a.tryAcquire(source)));
    const holders = attempts.filter((x) => x !== null);
    expect(holders).toHaveLength(1);
    const first = holders[0]!;
    expect(await b.renew(source, first)).toBe(true);
    await a.markAcknowledged(source, first, 42);
    await a.commit(source, first, 42);
    await a.release(source, first);
    const second = await b.tryAcquire(source);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first.token);
    expect(await a.renew(source, first)).toBe(false);
    await expect(a.markAcknowledged(source, first, 45)).rejects.toThrow(FirehoseFenceError);
    await expect(a.commit(source, first, 45)).rejects.toThrow(FirehoseFenceError);
    await a.release(source, first); // stale release must not evict the new owner
    expect(await b.renew(source, second!)).toBe(true);
    expect(await b.getResumeCursor(source, second!)).toBe(42);
    await b.release(source, second!);
  });

  it("keeps checkpoints monotonic while accepting inclusive replay", async () => {
    const source = unique(), store = new RedisAtFirehoseSourceFence(redis);
    const lease = (await store.tryAcquire(source))!;
    await store.markAcknowledged(source, lease, 120);
    await store.commit(source, lease, 115);
    await store.markAcknowledged(source, lease, 117); // replay: do not regress hot 120
    expect(await store.getResumeCursor(source, lease)).toBe(115);
    await expect(store.commit(source, lease, 121)).rejects.toThrow(/not acknowledged/);
    await store.markAcknowledged(source, lease, 121);
    await store.commit(source, lease, 121);
    await expect(store.commit(source, lease, 120)).rejects.toThrow(/regress/);
    expect(await store.getResumeCursor(source, lease)).toBe(121);
    await store.release(source, lease);
  });

  it("expires an unrenewed lease and never allows its previous owner to acknowledge", async () => {
    const source = unique(), store = new RedisAtFirehoseSourceFence(redis, 500);
    const first = (await store.tryAcquire(source))!;
    await store.markAcknowledged(source, first, 10);
    await new Promise(resolve => setTimeout(resolve, 700));
    const second = await store.tryAcquire(source);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first.token);
    await expect(store.markAcknowledged(source, first, 11)).rejects.toThrow(/expired/);
    await expect(store.commit(source, first, 11)).rejects.toThrow(/expired/);
    await store.markAcknowledged(source, second!, 11);
    await store.commit(source, second!, 11);
    await store.release(source, second!);
  });

  it("fails closed on Redis outages and rejects invalid cursor values", async () => {
    const source = unique(), store = new RedisAtFirehoseSourceFence({
      eval: async () => { throw new Error("Redis disconnected"); },
    });
    await expect(store.tryAcquire(source)).rejects.toThrow(/Redis disconnected/);
    const normal = new RedisAtFirehoseSourceFence(redis);
    const lease = (await normal.tryAcquire(source))!;
    await expect(normal.markAcknowledged(source, lease,
      Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/safe nonnegative/);
    await normal.release(source, lease);
  });
});
