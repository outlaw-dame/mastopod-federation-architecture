import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { RedisAtFirehoseSourceFence, FirehoseFenceError, externalSyncFenceKeys } from "../ingress/RedisAtFirehoseSourceFence.js";
import { createHash } from "node:crypto";

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
  it("co-locates lease and checkpoint keys in one Redis Cluster hash tag", () => {
    const a = externalSyncFenceKeys("wss://one.example/xrpc/com.atproto.sync.subscribeRepos");
    const b = externalSyncFenceKeys("wss://two.example/xrpc/com.atproto.sync.subscribeRepos");
    const group = (key:string) => key.split("{")[1]?.split("}")[0] ?? "";
    expect(group(a.owner)).toMatch(/^[a-f0-9]{40}$/);
    expect(new Set(Object.values(a).map(group)).size).toBe(1);
    expect(group(b.owner)).not.toBe(group(a.owner));
    expect(Object.values(a).every(k => k.startsWith("at:external-sync:v2:"))).toBe(true);
  });

  it("refuses legacy v1 cursors rather than silently starting a new live-only stream",async()=>{
    const source = unique();
    const digest=createHash("sha256").update(source).digest("hex").slice(0,40);
    const old="at:external-sync:v1:"+digest;
    const store=new RedisAtFirehoseSourceFence(redis);
    try{
      await redis.set(old+":committed","190");
      await expect(store.tryAcquire(source)).rejects.toThrow(/Legacy external Sync/);
      await redis.del(old+":committed");
      const lease=await store.tryAcquire(source);
      expect(lease).not.toBeNull();
      await store.release(source,lease!);
    }finally{await redis.del(old+":owner",old+":hot",old+":committed");}
  });

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

  it("bounds stalled Redis commands instead of holding the upstream forever", async()=>{
    const hung = new RedisAtFirehoseSourceFence({
      get: async () => null,
      eval: async () => new Promise<unknown>(() => {}),
    },600);
    await expect(hung.tryAcquire(unique())).rejects.toThrow(/deadline/);
    await expect(hung.markAcknowledged(unique(),{token:"stale:1"},1))
      .rejects.toThrow(/deadline/);
  });

  it("fails closed on Redis outages and rejects invalid cursor values", async () => {
    const source = unique(), store = new RedisAtFirehoseSourceFence({
      get: async () => { throw new Error("Redis disconnected"); },
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
