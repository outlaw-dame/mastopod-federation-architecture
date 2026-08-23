import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorAuthoritySigningRouter } from "./ActorAuthoritySigningRouter.js";

const originalDomain = process.env["DOMAIN"];

afterEach(() => {
  if (originalDomain === undefined) delete process.env["DOMAIN"];
  else process.env["DOMAIN"] = originalDomain;
});

function activityPodsSigner() {
  return {
    signOne: vi.fn(async () => ({
      requestId: "activitypods",
      ok: true as const,
      signedHeaders: {
        date: "Thu, 20 Aug 2026 14:00:00 GMT",
        signature: "activitypods-signature",
      },
    })),
  };
}

function sidecarSigner() {
  return {
    signHttpRequest: vi.fn(async () => ({
      date: "Thu, 20 Aug 2026 14:00:00 GMT",
      signature: 'keyId="https://example.com/users/relay#main-key",headers="(request-target) host date",signature="local",algorithm="rsa-sha256"',
    })),
  };
}

describe("ActorAuthoritySigningRouter", () => {
  it("routes the configured relay service actor only to the sidecar-local signer", async () => {
    const pods = activityPodsSigner();
    const local = sidecarSigner();
    const router = new ActorAuthoritySigningRouter(pods, local as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    const result = await router.signOne({
      actorUri: "https://example.com/users/relay",
      method: "GET",
      targetUrl: "https://remote.example/objects/1",
    });

    expect(result.ok).toBe(true);
    expect(router.classifyActor("https://example.com/users/relay")).toBe("sidecar_service_actor");
    expect(local.signHttpRequest).toHaveBeenCalledOnce();
    expect(local.signHttpRequest).toHaveBeenCalledWith({
      actorUri: "https://example.com/users/relay",
      identifier: "relay",
      method: "GET",
      targetUrl: "https://remote.example/objects/1",
    });
    expect(pods.signOne).not.toHaveBeenCalled();
  });

  it("routes non-service actors only to ActivityPods", async () => {
    const pods = activityPodsSigner();
    const local = sidecarSigner();
    const router = new ActorAuthoritySigningRouter(pods, local as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    const request = {
      actorUri: "https://example.com/alice",
      method: "GET" as const,
      targetUrl: "https://remote.example/objects/1",
    };
    const result = await router.signOne(request);

    expect(result.ok).toBe(true);
    expect(router.classifyActor(request.actorUri)).toBe("activitypods_pod_actor");
    expect(pods.signOne).toHaveBeenCalledWith(request);
    expect(local.signHttpRequest).not.toHaveBeenCalled();
  });

  it("does not fall back to ActivityPods when sidecar service signing fails", async () => {
    const pods = activityPodsSigner();
    const local = {
      signHttpRequest: vi.fn(async () => {
        throw new Error("redis key store unavailable");
      }),
    };
    const router = new ActorAuthoritySigningRouter(pods, local as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    const result = await router.signOne({
      actorUri: "https://example.com/users/relay",
      method: "GET",
      targetUrl: "https://remote.example/objects/1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("redis key store unavailable");
    }
    expect(pods.signOne).not.toHaveBeenCalled();
  });

  it("rejects a trailing-slash service actor that the dispatcher does not publish", () => {
    expect(() => new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay/", identifier: "relay" }],
    })).toThrow(/published Fedify actor route/u);
  });

  it("rejects arbitrary custom service actor paths", () => {
    expect(() => new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/service/relay", identifier: "relay" }],
    })).toThrow(/published Fedify actor route/u);
  });

  it("rejects a service actor host that differs from the configured public DOMAIN", () => {
    process.env["DOMAIN"] = "sidecar.example";
    expect(() => new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://other.example/users/relay", identifier: "relay" }],
    })).toThrow(/must match DOMAIN/u);
  });

  it("rejects dot-segment spellings before they can collapse into configured actor identity", () => {
    const router = new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    expect(() => router.classifyActor("https://example.com/users/a/../relay")).toThrow(/canonical URL serialization/u);
  });

  it("rejects URL spellings that the parser would silently canonicalize", () => {
    const router = new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    expect(() => router.classifyActor("https://EXAMPLE.com/users/alice")).toThrow(/canonical URL serialization/u);
    expect(() => router.classifyActor("https://example.com:443/users/alice")).toThrow(/canonical URL serialization/u);
  });

  it("rejects authority-ambiguous actor URI shapes", () => {
    const router = new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    expect(() => router.classifyActor(" https://example.com/users/relay")).toThrow(/exact URI/u);
    expect(() => router.classifyActor("https://example.com/users/relay?as=alice")).toThrow(/query/u);
    expect(() => router.classifyActor("did:example:relay")).toThrow(/protocol/u);
  });
});
