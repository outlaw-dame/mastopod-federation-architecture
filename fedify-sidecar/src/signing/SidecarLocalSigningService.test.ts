import { describe, expect, it, vi } from "vitest";
import { SidecarLocalSigningService } from "./SidecarLocalSigningService.js";

function makeRedisStub() {
  const hashes = new Map<string, Record<string, string>>();
  return {
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hset: vi.fn(async (key: string, value: Record<string, string>) => {
      hashes.set(key, { ...value });
      return 1;
    }),
    hashes,
  };
}

describe("SidecarLocalSigningService", () => {
  it("uses canonical key material for aliased service actor identifiers", async () => {
    const redis = makeRedisStub();
    const service = new SidecarLocalSigningService(redis as any, {
      keyAliases: new Map([["moderation", "provider"]]),
    });

    const providerKeyPair = await service.getOrCreateKeyPair("provider");
    const moderationKeyPair = await service.getOrCreateKeyPair("moderation");

    expect(moderationKeyPair).toEqual(providerKeyPair);
    expect(redis.hashes.has("sidecar:local:keypair:provider")).toBe(true);
    expect(redis.hashes.has("sidecar:local:keypair:moderation")).toBe(false);
  });

  it("keeps the alias actor URI in the HTTP Signature keyId", async () => {
    const redis = makeRedisStub();
    const service = new SidecarLocalSigningService(redis as any, {
      keyAliases: { moderation: "provider" },
    });

    const signature = await service.signHttpRequest({
      actorUri: "https://local.example/users/moderation",
      identifier: "moderation",
      method: "POST",
      targetUrl: "https://remote.example/inbox",
      body: "{}",
    });

    expect(signature.signature).toContain('keyId="https://local.example/users/moderation#main-key"');
    expect(redis.hashes.has("sidecar:local:keypair:provider")).toBe(true);
    expect(redis.hashes.has("sidecar:local:keypair:moderation")).toBe(false);
  });
});
