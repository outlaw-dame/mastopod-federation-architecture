import { describe, expect, it, vi } from "vitest";
import {
  RedisObservedAtIdentityStore,
  type ObservedAtIdentityRecord,
} from "./ObservedAtIdentityStore.js";

function makeRecord(
  did: string,
  overrides: Partial<ObservedAtIdentityRecord> = {},
): ObservedAtIdentityRecord {
  return {
    did,
    handle: null,
    pdsEndpoint: null,
    canonicalAccountId: null,
    activityPubActorUri: null,
    bound: false,
    firstSeenAt: "2026-08-15T00:00:00.000Z",
    lastSeenAt: "2026-08-15T00:00:00.000Z",
    totalSeen: 1,
    projectedCount: 0,
    skippedUnboundActorCount: 1,
    skippedOtherCount: 0,
    failedCount: 0,
    lastOutcome: "skipped_unbound_actor",
    ...overrides,
  };
}

class SessionRedis {
  public readonly smembers = vi.fn(async () => {
    throw new Error("derived views must not use SMEMBERS");
  });
  public readonly get = vi.fn(async () => null);
  public readonly set = vi.fn(async () => "OK");
  public readonly sadd = vi.fn(async () => 1);
  public readonly del = vi.fn(async (key: string) => {
    this.sessions.delete(key);
    return 1;
  });
  public readonly mgetCalls: string[][] = [];
  public readonly dedupeChunkSizes: number[] = [];
  public readonly openSessions: string[] = [];
  public failDedupe = false;

  private scanIndex = 0;
  private readonly sessions = new Map<string, Set<string>>();

  public constructor(
    private readonly pages: Array<[string, string[]]>,
    private readonly records: Map<string, ObservedAtIdentityRecord>,
  ) {}

  public readonly sscan = vi.fn(async () => {
    const page = this.pages[this.scanIndex] ?? ["0", []];
    this.scanIndex += 1;
    return page;
  });

  public readonly mget = vi.fn(async (...keys: string[]) => {
    this.mgetCalls.push(keys);
    return keys.map((key) => {
      const did = key.replace(/^protocol-bridge:observed-at-identities:did:/u, "");
      const record = this.records.get(did);
      return record ? JSON.stringify(record) : null;
    });
  });

  public readonly eval = vi.fn(async (
    _script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ) => {
    expect(numberOfKeys).toBe(1);
    const sessionKey = String(args[0]);
    const sentinel = String(args[1]);

    if (args.length === 3) {
      this.sessions.set(sessionKey, new Set([sentinel]));
      this.openSessions.push(sessionKey);
      return 1;
    }

    if (this.failDedupe) {
      this.sessions.delete(sessionKey);
      throw new Error("OBSERVED_AT_SCAN_SESSION_EXPIRED");
    }

    const session = this.sessions.get(sessionKey);
    if (!session || !session.has(sentinel)) {
      throw new Error("OBSERVED_AT_SCAN_SESSION_EXPIRED");
    }

    const dids = args.slice(3).map(String);
    this.dedupeChunkSizes.push(dids.length);
    const fresh: string[] = [];
    for (const did of dids) {
      if (!session.has(did)) {
        session.add(did);
        fresh.push(did);
      }
    }
    return fresh;
  });
}

function recordsFor(dids: string[]): Map<string, ObservedAtIdentityRecord> {
  return new Map(dids.map((did, index) => [
    did,
    makeRecord(did, {
      bound: index % 2 === 0,
      totalSeen: index + 1,
      projectedCount: index % 2 === 0 ? index + 1 : 0,
      skippedUnboundActorCount: index % 2 === 0 ? 0 : 1,
      lastOutcome: index % 2 === 0 ? "projected" : "skipped_unbound_actor",
      lastSeenAt: `2026-08-15T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }),
  ]));
}

describe("RedisObservedAtIdentityStore bounded derived views", () => {
  it("deduplicates repeated SSCAN members in Redis and cleans the scan session", async () => {
    const records = recordsFor(["did:plc:a", "did:plc:b", "did:plc:c"]);
    const redis = new SessionRedis([
      ["9", ["did:plc:a", "did:plc:b"]],
      ["0", ["did:plc:b", "did:plc:c"]],
    ], records);
    const store = new RedisObservedAtIdentityStore(redis as any);

    const dashboard = await store.getDashboard(2);

    expect(redis.smembers).not.toHaveBeenCalled();
    expect(dashboard.summary.totalObserved).toBe(3);
    expect(dashboard.summary.boundObserved).toBe(2);
    expect(redis.mgetCalls).toEqual([
      [
        "protocol-bridge:observed-at-identities:did:did:plc:a",
        "protocol-bridge:observed-at-identities:did:did:plc:b",
      ],
      ["protocol-bridge:observed-at-identities:did:did:plc:c"],
    ]);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(redis.openSessions[0]);
  });

  it("hard-chunks oversized SSCAN responses for both de-duplication and MGET", async () => {
    const dids = Array.from({ length: 260 }, (_, index) => `did:plc:${index}`);
    const redis = new SessionRedis([["0", dids]], recordsFor(dids));
    const store = new RedisObservedAtIdentityStore(redis as any);

    const summary = await store.getSummary();

    expect(summary.totalObserved).toBe(260);
    expect(redis.dedupeChunkSizes).toEqual([128, 128, 4]);
    expect(redis.mgetCalls.map((batch) => batch.length)).toEqual([128, 128, 4]);
    expect(Math.max(...redis.mgetCalls.map((batch) => batch.length))).toBeLessThanOrEqual(128);
  });

  it("streams summary and top/recent views without calling the explicit full-enumeration API", async () => {
    const dids = ["did:plc:a", "did:plc:b", "did:plc:c"];

    const summaryRedis = new SessionRedis([["0", dids]], recordsFor(dids));
    const summaryStore = new RedisObservedAtIdentityStore(summaryRedis as any);
    await expect(summaryStore.getSummary()).resolves.toMatchObject({ totalObserved: 3 });
    expect(summaryRedis.smembers).not.toHaveBeenCalled();

    const topRedis = new SessionRedis([["0", dids]], recordsFor(dids));
    const topStore = new RedisObservedAtIdentityStore(topRedis as any);
    const topBound = await topStore.listTopBound(1);
    expect(topBound).toHaveLength(1);
    expect(topRedis.smembers).not.toHaveBeenCalled();

    const recentRedis = new SessionRedis([["0", dids]], recordsFor(dids));
    const recentStore = new RedisObservedAtIdentityStore(recentRedis as any);
    const recent = await recentStore.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recentRedis.smembers).not.toHaveBeenCalled();
  });

  it("fails closed and cleans up when the Redis scan session disappears", async () => {
    const redis = new SessionRedis([["0", ["did:plc:a"]]], recordsFor(["did:plc:a"]));
    redis.failDedupe = true;
    const store = new RedisObservedAtIdentityStore(redis as any);

    await expect(store.getSummary()).rejects.toThrow(/SCAN_SESSION_EXPIRED/u);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it("keeps lightweight-adapter compatibility while chunking oversized pages", async () => {
    const dids = Array.from({ length: 260 }, (_, index) => `did:plc:${index}`);
    const records = recordsFor(dids);
    const mgetCalls: string[][] = [];
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => {
        throw new Error("bounded fallback must not use SMEMBERS when SSCAN/MGET exist");
      }),
      sscan: vi.fn(async () => ["0", dids] as [string, string[]]),
      mget: vi.fn(async (...keys: string[]) => {
        mgetCalls.push(keys);
        return keys.map((key) => {
          const did = key.replace(/^protocol-bridge:observed-at-identities:did:/u, "");
          return JSON.stringify(records.get(did));
        });
      }),
    };
    const store = new RedisObservedAtIdentityStore(redis as any);

    const summary = await store.getSummary();

    expect(summary.totalObserved).toBe(260);
    expect(mgetCalls.map((batch) => batch.length)).toEqual([128, 128, 4]);
    expect(redis.smembers).not.toHaveBeenCalled();
  });
});
