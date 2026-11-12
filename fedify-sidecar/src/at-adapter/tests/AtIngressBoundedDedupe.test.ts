import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import {
  Phase55AEventClassifier, Phase55BEventClassifier,
  type RedisClassifierClient,
} from "../ingress/AtIngressEventClassifier.js";

let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 2000,
  });
  await redis.ping();
});
afterAll(async () => { if (redis) await redis.quit().catch(() => redis.disconnect()); });
const keyFor = (source: string) => "at:firehose:dedupe:window:v2:" +
  createHash("sha256").update(source).digest("hex").slice(0, 40);
const source = (suffix: string) =>
  "wss://source-" + Date.now() + "-" + suffix + ".example.test/xrpc/com.atproto.sync.subscribeRepos";

describe("bounded source URL-scoped ATProto dedupe", () => {
  it("deduplicates relay URLs, isolates sources and bounds the Redis sorted set", async () => {
    const a = source("a"), b = source("b");
    const first = new Phase55AEventClassifier(redis, 16);
    const otherWorker = new Phase55AEventClassifier(redis, 16);
    expect(await first.isDuplicate(a, 1)).toBe(false);
    await first.markProcessed(a, 1);
    expect(await otherWorker.isDuplicate(a, 1)).toBe(true);
    expect(await otherWorker.isDuplicate(b, 1)).toBe(false);
    for(let seq=2;seq<=40;seq++)await first.markProcessed(a,seq);
    expect(await redis.zcard(keyFor(a))).toBe(16);
    expect(await first.isDuplicate(a, 40)).toBe(true);
    expect(await first.isDuplicate(a, 1)).toBe(false);
    await first.markProcessed(b, 1);
    expect(await first.isDuplicate(b, 1)).toBe(true);
    expect(await redis.zcard(keyFor(b))).toBe(1);
    await redis.del(keyFor(a), keyFor(b));
  });

  it("supports the allowlist classifier without reintroducing the DID-versus-URL bug", async () => {
    const a = source("allowlist");
    const classifier = new Phase55BEventClassifier(redis, 16);
    await classifier.markProcessed(a, 24);
    expect(await classifier.isDuplicate(a, 24)).toBe(true);
    await redis.del(keyFor(a));
  });

  it("rejects invalid source and oversized sequence rather than silently not deduplicating", async () => {
    const classifier = new Phase55AEventClassifier(redis, 16);
    await expect(classifier.isDuplicate("did:plc:not-a-relay", 1))
      .rejects.toThrow(/source/);
    await expect(classifier.markProcessed("wss://relay.example.test", Number.MAX_SAFE_INTEGER+1))
      .rejects.toThrow(/sequence/);
    expect(() => new Phase55AEventClassifier(redis, 0)).toThrow(/window/);
  });

  it("fails closed during Redis outage instead of trusting a replayed event", async () => {
    const failure = {
      zscore: vi.fn(async () => { throw new Error("Redis unavailable"); }),
      eval: vi.fn(async () => { throw new Error("Redis unavailable"); }),
    } as unknown as RedisClassifierClient;
    const classifier = new Phase55AEventClassifier(failure);
    await expect(classifier.isDuplicate(source("outage"), 5))
      .rejects.toThrow(/Redis unavailable/);
    await expect(classifier.markProcessed(source("outage"), 5))
      .rejects.toThrow(/Redis unavailable/);
  });
});
