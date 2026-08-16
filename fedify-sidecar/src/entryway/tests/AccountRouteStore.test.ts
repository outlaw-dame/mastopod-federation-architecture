import { describe, expect, it, vi } from "vitest";
import { RedisAccountRouteStore } from "../AccountRouteStore.js";
import type { AccountRoute } from "../types.js";

const PREFIX = "entryway-test";
const BEFORE_ISO = "2026-08-16T10:00:00.000Z";

function makeRoute(
  accountId: string,
  updatedAt: string,
  status: AccountRoute["status"] = "provisioning",
): AccountRoute {
  return {
    accountId,
    username: accountId,
    handle: `${accountId}.example.com`,
    webId: `https://pods.example/${accountId}`,
    actorId: `https://pods.example/${accountId}`,
    podStorageUrl: `https://pods.example/${accountId}/data/`,
    providerId: "provider-a",
    providerBaseUrl: "https://pods.example",
    oidcIssuer: "https://pods.example",
    status,
    provisioning: {
      phase: "PENDING",
      attempts: 0,
      idempotencyKeyHash: `idem-${accountId}`,
      requestFingerprint: `fp-${accountId}`,
      checks: [],
    },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt,
  };
}

describe("RedisAccountRouteStore.listStaleProvisioning", () => {
  it("loads candidate routes in bounded MGET batches without per-route GETs", async () => {
    const accountIds = Array.from({ length: 520 }, (_, index) => `account-${index}`);
    const values = new Map<string, string | null>();
    for (const [index, accountId] of accountIds.entries()) {
      const updatedAt = new Date(Date.parse(BEFORE_ISO) - (index + 1) * 1000).toISOString();
      values.set(`${PREFIX}:route:${accountId}`, JSON.stringify(makeRoute(accountId, updatedAt)));
    }

    const get = vi.fn(async () => {
      throw new Error("per-route GET must not be used by stale route scan");
    });
    const mget = vi.fn(async (...keys: string[]) => keys.map((key) => values.get(key) ?? null));
    const zrangebyscore = vi.fn(async () => accountIds);
    const store = new RedisAccountRouteStore({ get, mget, zrangebyscore } as any, PREFIX);

    const routes = await store.listStaleProvisioning(BEFORE_ISO, 500);

    expect(routes).toHaveLength(500);
    expect(get).not.toHaveBeenCalled();
    expect(mget).toHaveBeenCalledTimes(3);
    expect(mget.mock.calls.map((call) => call.length)).toEqual([256, 256, 8]);
    expect(mget.mock.calls.flat()).toEqual(accountIds.map((accountId) => `${PREFIX}:route:${accountId}`));
    expect(zrangebyscore).toHaveBeenCalledWith(
      `${PREFIX}:index`,
      "-inf",
      String(Date.parse(BEFORE_ISO)),
      "LIMIT",
      0,
      1500,
    );
    expect(routes[0]?.accountId).toBe("account-519");
    expect(routes[499]?.accountId).toBe("account-20");
  });

  it("preserves missing, malformed, status, cutoff, sort, and limit semantics", async () => {
    const accountIds = ["missing", "malformed", "active", "newer", "older-b", "older-a"];
    const values = new Map<string, string | null>([
      [`${PREFIX}:route:missing`, null],
      [`${PREFIX}:route:malformed`, "{not-json"],
      [`${PREFIX}:route:active`, JSON.stringify(makeRoute("active", "2026-08-16T09:00:00.000Z", "active"))],
      [`${PREFIX}:route:newer`, JSON.stringify(makeRoute("newer", "2026-08-16T10:00:00.000Z"))],
      [`${PREFIX}:route:older-b`, JSON.stringify(makeRoute("older-b", "2026-08-16T09:30:00.000Z"))],
      [`${PREFIX}:route:older-a`, JSON.stringify(makeRoute("older-a", "2026-08-16T08:30:00.000Z"))],
    ]);
    const mget = vi.fn(async (...keys: string[]) => keys.map((key) => values.get(key) ?? null));
    const store = new RedisAccountRouteStore({
      get: vi.fn(),
      mget,
      zrangebyscore: vi.fn(async () => accountIds),
    } as any, PREFIX);

    const routes = await store.listStaleProvisioning(BEFORE_ISO, 1);

    expect(routes.map((route) => route.accountId)).toEqual(["older-a"]);
    expect(mget).toHaveBeenCalledTimes(1);
  });

  it("treats a short MGET response as missing trailing route values without shifting alignment", async () => {
    const accountIds = ["first", "second", "third"];
    const first = makeRoute("first", "2026-08-16T08:00:00.000Z");
    const second = makeRoute("second", "2026-08-16T09:00:00.000Z");
    const store = new RedisAccountRouteStore({
      get: vi.fn(),
      zrangebyscore: vi.fn(async () => accountIds),
      mget: vi.fn(async () => [JSON.stringify(first), JSON.stringify(second)]),
    } as any, PREFIX);

    const routes = await store.listStaleProvisioning(BEFORE_ISO, 10);

    expect(routes.map((route) => route.accountId)).toEqual(["first", "second"]);
  });
});