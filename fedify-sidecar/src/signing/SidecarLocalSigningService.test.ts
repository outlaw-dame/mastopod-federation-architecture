import { createVerify } from "node:crypto";
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

function signatureValue(header: string): string {
  const match = /signature="([^"]+)"/.exec(header);
  if (!match?.[1]) throw new Error("missing signature value");
  return match[1];
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

  it("serializes concurrent first-use creation across service instances", async () => {
    const redis = makeRedisStub();
    const first = new SidecarLocalSigningService(redis as any);
    const second = new SidecarLocalSigningService(redis as any);

    const [firstKey, secondKey] = await Promise.all([
      first.getOrCreateKeyPair("relay-concurrent"),
      second.getOrCreateKeyPair("relay-concurrent"),
    ]);

    expect(secondKey).toEqual(firstKey);
    expect(redis.hset).toHaveBeenCalledTimes(1);
    expect(redis.hashes.get("sidecar:local:keypair:relay-concurrent")).toEqual(firstKey);
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
    expect(signature.signature).toContain('headers="(request-target) host date digest"');
    expect(signature.digest).toMatch(/^SHA-256=/);
    expect(redis.hashes.has("sidecar:local:keypair:provider")).toBe(true);
    expect(redis.hashes.has("sidecar:local:keypair:moderation")).toBe(false);
  });

  it("signs authenticated GET without inventing a Digest header", async () => {
    const redis = makeRedisStub();
    const service = new SidecarLocalSigningService(redis as any);
    const actorUri = "https://local.example/users/relay";
    const targetUrl = "https://remote.example/objects/123?view=activitypub";

    const result = await service.signHttpRequest({
      actorUri,
      identifier: "relay",
      method: "GET",
      targetUrl,
    });

    expect(result.digest).toBeUndefined();
    expect(result.signature).toContain(`keyId="${actorUri}#main-key"`);
    expect(result.signature).toContain('headers="(request-target) host date"');
    expect(result.signature).not.toContain("digest");

    const { publicKeyPem } = await service.getOrCreateKeyPair("relay");
    const signingString = [
      "(request-target): get /objects/123?view=activitypub",
      "host: remote.example",
      `date: ${result.date}`,
    ].join("\n");
    const verifier = createVerify("sha256");
    verifier.update(signingString);
    verifier.end();
    expect(verifier.verify(publicKeyPem, signatureValue(result.signature), "base64")).toBe(true);
  });
});
