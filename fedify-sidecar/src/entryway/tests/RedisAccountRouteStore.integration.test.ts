import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RedisAccountRouteStore } from "../AccountRouteStore.js";
import type { AccountRoute } from "../types.js";

// Real Redis proof is intentionally opt-in locally and mandatory in the
// protected Fast Checks workflow. No fake EVAL or simulated Lua semantics.
const run = process.env["ENTRYWAY_REDIS_INTEGRATION"] === "1";
const redisUrl = process.env["REDIS_URL"] || "redis://127.0.0.1:6379";

function makeRoute(accountId: string, username: string, overrides: Partial<AccountRoute> = {}): AccountRoute {
  return {
    accountId,
    username,
    handle: `@${username}@example.org`,
    webId: `https://provider.example/${username}/profile/card#me`,
    actorId: `https://provider.example/${username}`,
    podStorageUrl: `https://provider.example/${username}/data/`,
    providerId: "example-provider",
    providerBaseUrl: "https://provider.example",
    oidcIssuer: "https://provider.example",
    status: "provisioning",
    provisioning: {
      phase: "USERNAME_RESERVED",
      attempts: 0,
      idempotencyKeyHash: `idem-${accountId}`,
      requestFingerprint: `fp-${accountId}`,
      checks: [],
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function claim(route: AccountRoute, fenceToken: string): AccountRoute {
  return {
    ...route,
    revision: (route.revision ?? 0) + 1,
    provisioning: {
      ...route.provisioning,
      attempts: route.provisioning.attempts + 1,
      fenceToken,
    },
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe.skipIf(!run)("RedisAccountRouteStore real Lua fencing and pending-index repair", () => {
  let redis: Redis;
  let prefix: string;
  let store: RedisAccountRouteStore;
  const cleanup = new Set<string>();

  beforeAll(async () => {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
    });
    await redis.connect();
    const server = await redis.info("server");
    const version = server.match(/redis_version:(\d+)\.(\d+)/);
    expect(version).not.toBeNull();
    const major = Number(version?.[1]);
    const minor = Number(version?.[2]);
    expect(major > 8 || (major === 8 && minor >= 2)).toBe(true);
    prefix = `entryway:integration:${randomUUID()}`;
    store = new RedisAccountRouteStore(redis, prefix);
    cleanup.add(`${prefix}:index`);
  });
  afterAll(async () => {
    if (!redis) return;
    if (cleanup.size) await redis.del(...cleanup);
    await redis.quit();
  });

  function track(route: AccountRoute): void {
    cleanup.add(`${prefix}:route:${route.accountId}`);
    cleanup.add(`${prefix}:username:${route.username}`);
    cleanup.add(`${prefix}:idempotency:${route.provisioning.idempotencyKeyHash}`);
  }

  it("atomically admits one claimant and never downgrades an activated route", async () => {
    const old = makeRoute(`acct_${randomUUID()}`, "alice");
    track(old);
    const reservation = await store.reserve({
      accountId: old.accountId,
      username: old.username,
      idempotencyKeyHash: old.provisioning.idempotencyKeyHash,
      requestFingerprint: old.provisioning.requestFingerprint,
      route: old,
    });
    expect(reservation.kind).toBe("created");

    const [first, second] = await Promise.all([
      store.compareAndSet(old, claim(old, "attempt-a")),
      store.compareAndSet(old, claim(old, "attempt-b")),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const winner = await store.getByAccountId(old.accountId);
    expect(winner?.revision).toBe(1);
    expect(winner?.provisioning.fenceToken).toBe(first ? "attempt-a" : "attempt-b");
    expect(await store.compareAndSet(old, claim(old, "late-attempt"))).toBe(false);

    const active: AccountRoute = {
      ...winner!,
      revision: 2,
      status: "active",
      provisioning: { ...winner!.provisioning, phase: "ACTIVE" },
    };
    expect(await store.compareAndSet(winner!, active)).toBe(true);
    expect(await redis.zscore(`${prefix}:index`, old.accountId)).toBeNull();
    expect(await store.compareAndSet(active, {
      ...active,
      revision: 3,
      status: "failed",
    })).toBe(false);
    expect((await store.getByAccountId(old.accountId))?.status).toBe("active");
  });

  it("atomically excludes pending consent from recovery and permits fenced client resumption", async () => {
    const old = makeRoute(`acct_${randomUUID()}`, "consentuser");
    track(old);
    expect((await store.reserve({
      accountId: old.accountId,
      username: old.username,
      idempotencyKeyHash: old.provisioning.idempotencyKeyHash,
      requestFingerprint: old.provisioning.requestFingerprint,
      route: old,
    })).kind).toBe("created");

    const first = claim(old, "initial-attempt");
    expect(await store.compareAndSet(old, first)).toBe(true);
    const waiting: AccountRoute = {
      ...first,
      revision: 2,
      status: "awaiting_consent",
      provisioning: {
        ...first.provisioning,
        phase: "AWAITING_APP_CONSENT",
      },
    };
    expect(await store.compareAndSet(first, waiting)).toBe(true);
    expect(await redis.zscore(`${prefix}:index`, old.accountId)).toBeNull();
    const staleCandidates = await store.listStaleProvisioning("2030-01-01T00:00:00.000Z", 25);
    expect(staleCandidates.some((entry) => entry.accountId === old.accountId)).toBe(false);
    expect(await store.compareAndSet(waiting, {
      ...waiting, revision: 3, status: "active",
    })).toBe(false);

    const resumed: AccountRoute = {
      ...claim(waiting, "consent-approved"),
      status: "provisioning",
    };
    expect(await store.compareAndSet(waiting, resumed)).toBe(true);
    expect(await redis.zscore(`${prefix}:index`, old.accountId)).not.toBeNull();
    expect(await store.compareAndSet(waiting, {
      ...claim(waiting, "stale-worker"), status: "provisioning",
    })).toBe(false);
    const active: AccountRoute = {
      ...resumed,
      revision: 4,
      status: "active",
      provisioning: { ...resumed.provisioning, phase: "ACTIVE" },
    };
    expect(await store.compareAndSet(resumed, active)).toBe(true);
    expect(await redis.zscore(`${prefix}:index`, old.accountId)).toBeNull();
    expect((await store.getByAccountId(old.accountId))?.status).toBe("active");
  });

  it("atomically quarantines incomplete account evidence outside the recovery index", async () => {
    const route = makeRoute(`acct_${randomUUID()}`, "incomplete");
    track(route);
    expect((await store.reserve({
      accountId: route.accountId, username: route.username,
      idempotencyKeyHash: route.provisioning.idempotencyKeyHash,
      requestFingerprint: route.provisioning.requestFingerprint,
      route,
    })).kind).toBe("created");
    const claimed = claim(route, "reconcile-fence");
    expect(await store.compareAndSet(route, claimed)).toBe(true);
    const frozen: AccountRoute = {
      ...claimed,
      status: "reconciliation_required",
      revision: (claimed.revision ?? 0) + 1,
      provisioning: {
        ...claimed.provisioning,
        phase: "RECONCILIATION_REQUIRED",
        lastErrorCode: "account_identity_incomplete",
      },
    };
    expect(await store.compareAndSet(claimed, frozen)).toBe(true);
    expect(await redis.zscore(`${prefix}:index`, route.accountId)).toBeNull();
    expect((await store.getByAccountId(route.accountId))?.status).toBe("reconciliation_required");
    expect(await store.compareAndSet(frozen, {
      ...frozen, revision: (frozen.revision ?? 0) + 1,
      status: "provisioning",
    })).toBe(false);
    expect((await store.listStaleProvisioning("2030-01-01T00:00:00.000Z", 20))
      .some(candidate => candidate.accountId === route.accountId)).toBe(false);
  });

  it("never permits a new worker to erase an external-create uncertainty marker", async () => {
    const route = makeRoute(`acct_${randomUUID()}`, "uncertain");
    track(route);
    expect((await store.reserve({
      accountId: route.accountId, username: route.username,
      idempotencyKeyHash: route.provisioning.idempotencyKeyHash,
      requestFingerprint: route.provisioning.requestFingerprint, route,
    })).kind).toBe("created");
    const held = claim(route, "first-owner");
    expect(await store.compareAndSet(route, held)).toBe(true);
    const started: AccountRoute = {
      ...held, revision: 2,
      provisioning: {
        ...held.provisioning,
        phase: "PROVIDER_CREATE_STARTED",
        providerCreateMayHaveSideEffects: true,
      },
    };
    expect(await store.compareAndSet(held, started)).toBe(true);
    const erased: AccountRoute = {
      ...started, revision: 3,
      provisioning: {
        ...started.provisioning,
        providerCreateMayHaveSideEffects: false,
      },
    };
    expect(await store.compareAndSet(started, erased)).toBe(false);
    expect((await store.getByAccountId(route.accountId))?.provisioning
      .providerCreateMayHaveSideEffects).toBe(true);
    const reconciled: AccountRoute = {
      ...started, revision: 3, status: "reconciliation_required",
      provisioning: {
        ...started.provisioning,
        phase: "RECONCILIATION_REQUIRED",
      },
    };
    expect(await store.compareAndSet(started, reconciled)).toBe(true);
    expect(await redis.zscore(`${prefix}:index`, route.accountId)).toBeNull();
  });

  it("drains legacy active records and repairs legacy creation-time scores", async () => {
    const active = makeRoute(`acct_${randomUUID()}`, "oldactive", { status: "active" });
    const recent = makeRoute(`acct_${randomUUID()}`, "recent", {
      updatedAt: "2026-11-12T00:00:00.000Z",
    });
    const stale = makeRoute(`acct_${randomUUID()}`, "stale", {
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    for (const route of [active, recent, stale]) {
      track(route);
      await redis.set(`${prefix}:route:${route.accountId}`, JSON.stringify(route));
      await redis.zadd(`${prefix}:index`, String(Date.parse(route.createdAt)), route.accountId);
    }
    const found = await store.listStaleProvisioning("2026-11-01T00:00:00.000Z", 10);
    expect(found.map((route) => route.accountId)).toContain(stale.accountId);
    expect(found.map((route) => route.accountId)).not.toContain(active.accountId);
    expect(found.map((route) => route.accountId)).not.toContain(recent.accountId);
    expect(await redis.zscore(`${prefix}:index`, active.accountId)).toBeNull();
    expect(Number(await redis.zscore(`${prefix}:index`, recent.accountId)))
      .toBe(Date.parse(recent.updatedAt));
    expect(Number(await redis.zscore(`${prefix}:index`, stale.accountId)))
      .toBe(Date.parse(stale.updatedAt));

    // A second pass must not repeatedly encounter the active or recent
    // legacy entries once the index has been repaired.
    const again = await store.listStaleProvisioning("2026-11-01T00:00:00.000Z", 10);
    expect(again.map((route) => route.accountId)).toContain(stale.accountId);
    expect(await redis.zscore(`${prefix}:index`, active.accountId)).toBeNull();
  });
});
