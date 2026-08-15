import { describe, expect, it, vi } from "vitest";
import {
  RedisObservedAtIdentityStore,
  type ObservedAtIdentityRecord,
} from "./ObservedAtIdentityStore.js";

function record(
  did: string,
  options: Partial<ObservedAtIdentityRecord> = {},
): ObservedAtIdentityRecord {
  return {
    did,
    handle: null,
    pdsEndpoint: null,
    canonicalAccountId: null,
    activityPubActorUri: null,
    bound: false,
    firstSeenAt: "2026-08-14T20:00:00.000Z",
    lastSeenAt: "2026-08-14T20:00:00.000Z",
    totalSeen: 1,
    projectedCount: 0,
    skippedUnboundActorCount: 1,
    skippedOtherCount: 0,
    failedCount: 0,
    lastOutcome: "skipped_unbound_actor",
    ...options,
  };
}

describe("RedisObservedAtIdentityStore dashboard", () => {
  it("aggregates summary and top lists in one SSCAN traversal with page MGETs", async () => {
    const records = new Map<string, ObservedAtIdentityRecord>([
      ["did:plc:a", record("did:plc:a", { totalSeen: 4, lastSeenAt: "2026-08-14T20:01:00.000Z" })],
      ["did:plc:b", record("did:plc:b", {
        bound: true,
        totalSeen: 10,
        projectedCount: 10,
        skippedUnboundActorCount: 0,
        lastOutcome: "projected",
        lastSeenAt: "2026-08-14T20:03:00.000Z",
      })],
      ["did:plc:c", record("did:plc:c", { totalSeen: 8, lastSeenAt: "2026-08-14T20:02:00.000Z" })],
    ]);
    let scanPage = 0;
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => {
        throw new Error("dashboard must not use SMEMBERS when SSCAN/MGET are available");
      }),
      sscan: vi.fn(async () => {
        scanPage += 1;
        return scanPage === 1
          ? ["7", ["did:plc:a", "did:plc:b"]] as [string, string[]]
          : ["0", ["did:plc:b", "did:plc:c"]] as [string, string[]];
      }),
      mget: vi.fn(async (...keys: string[]) => keys.map((key) => {
        const did = key.replace(/^protocol-bridge:observed-at-identities:did:/u, "");
        const value = records.get(did);
        return value ? JSON.stringify(value) : null;
      })),
    };
    const store = new RedisObservedAtIdentityStore(redis);

    const dashboard = await store.getDashboard(1);

    expect(redis.sscan).toHaveBeenCalledTimes(2);
    expect(redis.mget).toHaveBeenCalledTimes(2);
    expect(redis.mget.mock.calls[1]).toEqual([
      "protocol-bridge:observed-at-identities:did:did:plc:c",
    ]);
    expect(redis.smembers).not.toHaveBeenCalled();
    expect(dashboard.summary).toEqual({
      totalObserved: 3,
      boundObserved: 1,
      unboundObserved: 2,
      projectedCount: 10,
      skippedUnboundActorCount: 2,
      skippedOtherCount: 0,
      failedCount: 0,
    });
    expect(dashboard.topBound.map((item) => item.did)).toEqual(["did:plc:b"]);
    expect(dashboard.topUnbound.map((item) => item.did)).toEqual(["did:plc:c"]);
    expect(dashboard.recent.map((item) => item.did)).toEqual(["did:plc:b"]);
  });

  it("retains only the requested top-N records while scanning", async () => {
    const records = [
      record("did:plc:a", { totalSeen: 1 }),
      record("did:plc:b", { totalSeen: 5 }),
      record("did:plc:c", { totalSeen: 3 }),
    ];
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => []),
      sscan: vi.fn(async () => ["0", records.map((item) => item.did)] as [string, string[]]),
      mget: vi.fn(async () => records.map((item) => JSON.stringify(item))),
    };
    const store = new RedisObservedAtIdentityStore(redis);

    const dashboard = await store.getDashboard(2);

    expect(dashboard.topUnbound.map((item) => item.totalSeen)).toEqual([5, 3]);
    expect(dashboard.topUnbound).toHaveLength(2);
    expect(dashboard.recent).toHaveLength(2);
  });
});
