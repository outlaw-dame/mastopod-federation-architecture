import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountRouteStore, RedisAccountRouteStore } from "../AccountRouteStore.js";
import type { AccountRoute } from "../types.js";

function route(status: AccountRoute["status"] = "provisioning"): AccountRoute {
  return {
    accountId: "acct_11111111-1111-4111-8111-111111111111",
    revision: 0,
    username: "alice",
    handle: "",
    webId: "",
    actorId: "",
    podStorageUrl: "",
    providerId: "",
    providerBaseUrl: "",
    oidcIssuer: "",
    status,
    provisioning: {
      phase: "USERNAME_RESERVED",
      attempts: 0,
      idempotencyKeyHash: "idempotency-hmac",
      requestFingerprint: "request-hmac",
      checks: [],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function nextAttempt(from: AccountRoute, token: string): AccountRoute {
  return {
    ...from,
    revision: (from.revision ?? 0) + 1,
    status: "provisioning",
    provisioning: { ...from.provisioning, fenceToken: token, attempts: from.provisioning.attempts + 1 },
    updatedAt: "2026-01-01T01:00:00.000Z",
  };
}

describe("AccountRoute CAS fencing", () => {
  it("only one concurrent stale-attempt acquisition succeeds", async () => {
    const store = new InMemoryAccountRouteStore();
    const old = route();
    await store.save(old);
    const result = await Promise.all([
      store.compareAndSet(old, nextAttempt(old, "first-attempt")),
      store.compareAndSet(old, nextAttempt(old, "second-attempt")),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const winning = await store.getByAccountId(old.accountId);
    expect(winning?.revision).toBe(1);
    expect(winning?.provisioning.fenceToken).toBe("first-attempt");
  });

  it("rejects stale writes, forged revision jumps and resurrection after activation", async () => {
    const store = new InMemoryAccountRouteStore();
    const old = route();
    await store.save(old);
    const claimed = nextAttempt(old, "first-attempt");
    expect(await store.compareAndSet(old, claimed)).toBe(true);
    expect(await store.compareAndSet(old, nextAttempt(old, "late-attempt"))).toBe(false);
    expect(await store.compareAndSet(claimed, { ...claimed, revision: 99 })).toBe(false);

    const active: AccountRoute = {
      ...claimed,
      revision: 2,
      status: "active",
      provisioning: { ...claimed.provisioning, phase: "ACTIVE" },
    };
    expect(await store.compareAndSet(claimed, active)).toBe(true);
    expect(await store.compareAndSet(active, {
      ...active, revision: 3, status: "failed",
    })).toBe(false);
    expect((await store.getByAccountId(old.accountId))?.status).toBe("active");
  });

  it("does not index consent-pending accounts or accept stale activation during resume", async () => {
    const store = new InMemoryAccountRouteStore();
    const old = route();
    await store.save(old);
    const claimed = nextAttempt(old, "first-attempt");
    expect(await store.compareAndSet(old, claimed)).toBe(true);

    const waiting: AccountRoute = {
      ...claimed,
      revision: 2,
      status: "awaiting_consent",
      provisioning: {
        ...claimed.provisioning,
        phase: "AWAITING_APP_CONSENT",
      },
    };
    expect(await store.compareAndSet(claimed, waiting)).toBe(true);
    expect(await store.listStaleProvisioning("2030-01-01T00:00:00.000Z", 25)).toEqual([]);
    const forbidden = { ...waiting, revision: 3, status: "active" as const };
    expect(await store.compareAndSet(waiting, forbidden)).toBe(false);
    expect(await store.compareAndSet(claimed, {
      ...claimed, revision: 3, status: "active",
    })).toBe(false);

    const newClaim = nextAttempt(waiting, "after-native-sai-consent");
    expect(await store.compareAndSet(waiting, newClaim)).toBe(true);
    expect(await store.compareAndSet(waiting, nextAttempt(waiting, "attacker"))).toBe(false);
    const active: AccountRoute = {
      ...newClaim,
      revision: 4,
      status: "active",
      provisioning: { ...newClaim.provisioning, phase: "ACTIVE" },
    };
    expect(await store.compareAndSet(newClaim, active)).toBe(true);
    expect((await store.getByAccountId(old.accountId))?.status).toBe("active");
  });

  it("rejects mutations to immutable username and idempotency scope", async () => {
    const store = new InMemoryAccountRouteStore();
    const old = route();
    await store.save(old);
    for (const changed of [
      { username: "bob" },
      { accountId: "acct_22222222-2222-4222-8222-222222222222" },
      { createdAt: "2026-01-02T00:00:00.000Z" },
      { provisioning: { ...old.provisioning, requestFingerprint: "changed" } },
    ]) {
      expect(await store.compareAndSet(old, { ...nextAttempt(old, "new"), ...changed })).toBe(false);
    }
  });

  it("sends revision and old fence to one atomic Redis script, never a SET pipeline", async () => {
    const evalMock = vi.fn(async (..._args: unknown[]) => 1);
    const redis = {
      eval: evalMock,
      pipeline: vi.fn(() => { throw new Error("CAS must not use a pipeline"); }),
    };
    const store = new RedisAccountRouteStore(redis as any, "entryway-test");
    const old = nextAttempt(route(), "first-attempt");
    const next = {
      ...old,
      revision: 2,
      status: "active" as const,
      provisioning: { ...old.provisioning, phase: "ACTIVE" as const },
    };
    expect(await store.compareAndSet(old, next)).toBe(true);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const args = evalMock.mock.calls[0]!;
    expect(args[1]).toBe(2);
    expect(args[2]).toBe(`entryway-test:route:${old.accountId}`);
    expect(args[3]).toBe("entryway-test:index");
    expect(args[4]).toBe("1");
    expect(args[5]).toBe("first-attempt");
    expect(JSON.parse(String(args[6]))).toMatchObject({ status: "active", revision: 2 });
    expect(args[8]).toBe(old.accountId);
  });

  it("treats a Redis revision conflict as a non-write", async () => {
    const redis = { eval: vi.fn(async () => 0) };
    const store = new RedisAccountRouteStore(redis as any);
    const old = route();
    expect(await store.compareAndSet(old, nextAttempt(old, "attempt"))).toBe(false);
  });
});
