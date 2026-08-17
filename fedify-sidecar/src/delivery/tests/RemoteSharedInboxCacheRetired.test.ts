import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import {
  RemoteSharedInboxCache,
  deriveActorUrl,
} from "../RemoteSharedInboxCache.js";

function makeForbiddenRedis(): Redis {
  return {
    get: vi.fn(() => {
      throw new Error("retired sharedInbox shim must not read Redis");
    }),
    set: vi.fn(() => {
      throw new Error("retired sharedInbox shim must not write Redis");
    }),
    del: vi.fn(() => {
      throw new Error("retired sharedInbox shim must not delete Redis state");
    }),
  } as unknown as Redis;
}

describe("RemoteSharedInboxCache retired compatibility shim", () => {
  it("preserves authoritative APDM targets without Redis or actor rediscovery", async () => {
    const redis = makeForbiddenRedis();
    const shim = new RemoteSharedInboxCache(redis, "test-agent");
    const targets = [
      {
        inboxUrl: "https://remote.example/users/alice/inbox",
        deliveryUrl: "https://remote.example/users/alice/inbox",
        targetDomain: "remote.example",
      },
      {
        inboxUrl: "https://remote.example/users/bob/inbox",
        sharedInboxUrl: "https://remote.example/inbox",
        deliveryUrl: "https://remote.example/inbox",
        targetDomain: "remote.example",
      },
    ];

    const result = await shim.enrichTargets(targets);

    expect(result).toBe(targets);
    expect(result).toEqual(targets);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("never manufactures domain-level shared-inbox authority", async () => {
    const redis = makeForbiddenRedis();
    const shim = new RemoteSharedInboxCache(redis, "test-agent");

    await expect(
      shim.resolveForDomain(
        "remote.example",
        "https://remote.example/users/alice/inbox",
      ),
    ).resolves.toBeNull();
    await expect(shim.invalidate("remote.example")).resolves.toBeUndefined();

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("retains the legacy pure URL helper without making it delivery authority", () => {
    expect(deriveActorUrl("https://remote.example/users/alice/inbox")).toBe(
      "https://remote.example/users/alice",
    );
    expect(deriveActorUrl("http://remote.example/users/alice/inbox")).toBeNull();
    expect(deriveActorUrl("https://remote.example/shared")).toBeNull();
  });
});
