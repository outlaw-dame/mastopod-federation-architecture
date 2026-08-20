import { describe, expect, it, vi } from "vitest";
import { ActorAuthoritySigningRouter } from "./ActorAuthoritySigningRouter.js";

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

  it("keeps trailing-slash-distinct actor IRIs in different authority domains", async () => {
    const pods = activityPodsSigner();
    const local = sidecarSigner();
    const router = new ActorAuthoritySigningRouter(pods, local as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay/", identifier: "relay" }],
    });

    expect(router.classifyActor("https://example.com/users/relay/")).toBe("sidecar_service_actor");
    expect(router.classifyActor("https://example.com/users/relay")).toBe("activitypods_pod_actor");

    await router.signOne({
      actorUri: "https://example.com/users/relay",
      method: "GET",
      targetUrl: "https://remote.example/objects/1",
    });
    expect(pods.signOne).toHaveBeenCalledOnce();
    expect(local.signHttpRequest).not.toHaveBeenCalled();
  });

  it("does not collapse dot-segment spellings into configured actor identity", () => {
    const router = new ActorAuthoritySigningRouter(activityPodsSigner(), sidecarSigner() as any, {
      sidecarServiceActors: [{ actorUri: "https://example.com/users/relay", identifier: "relay" }],
    });

    expect(router.classifyActor("https://example.com/users/a/../relay")).toBe("activitypods_pod_actor");
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
