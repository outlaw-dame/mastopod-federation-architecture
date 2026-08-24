import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The executable proof helper is intentionally plain ESM without a declaration file.
import { hasProcessedSidecarAccept, queryFollowingMembership, resolveCanonicalRemoteActorUri } from "../../../interop/ap/scripts/assert-real-return-accept.mjs";

const origin = {
  remoteActorUri: "https://remote.example/users/bob",
  canonicalRemoteActorUri: "https://remote.example/ap/users/123",
};

afterEach(() => vi.unstubAllGlobals());

describe("public following collection evidence", () => {
  it("finds exact membership through bounded same-origin pagination", async () => {
    const responses = new Map([
      ["https://activitypods.example/alice/following", {
        id: "https://activitypods.example/alice/following",
        type: "Collection",
        first: "https://activitypods.example/alice/following?page=1",
      }],
      ["https://activitypods.example/alice/following?page=1", {
        type: "CollectionPage",
        items: [origin.canonicalRemoteActorUri],
      }],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const body = responses.get(String(url));
      return new Response(JSON.stringify(body), {
        status: body ? 200 : 404,
        headers: { "content-type": "application/activity+json" },
      });
    }));

    await expect(queryFollowingMembership(origin, "https://activitypods.example/alice/following"))
      .resolves.toBe(true);
  });

  it("rejects pagination that escapes the ActivityPods authority", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      type: "Collection",
      first: "https://evil.example/collect",
    }), { status: 200 })));

    await expect(queryFollowingMembership(origin, "https://activitypods.example/alice/following"))
      .rejects.toThrow(/escaped its authority/u);
  });

  it("rejects a following response redirected outside its requested authority", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://evil.example/collect",
      json: async () => ({ items: [origin.canonicalRemoteActorUri] }),
    } as Response)));

    await expect(queryFollowingMembership(origin, "https://activitypods.example/alice/following"))
      .rejects.toThrow(/redirected outside its requested authority/u);
  });

  it("binds a requested actor alias to a same-authority canonical actor id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: origin.canonicalRemoteActorUri,
      type: "Person",
    }), { status: 200 })));

    await expect(resolveCanonicalRemoteActorUri(origin.remoteActorUri))
      .resolves.toBe(origin.canonicalRemoteActorUri);
  });

  it("rejects a canonical actor id that escapes the requested authority", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "https://evil.example/ap/users/123",
      type: "Person",
    }), { status: 200 })));

    await expect(resolveCanonicalRemoteActorUri(origin.remoteActorUri))
      .rejects.toThrow(/escaped its requested HTTPS authority/u);
  });

  it("rejects a non-actor document even when its id stays on the requested authority", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: origin.canonicalRemoteActorUri,
      type: "Note",
    }), { status: 200 })));

    await expect(resolveCanonicalRemoteActorUri(origin.remoteActorUri))
      .rejects.toThrow(/supported ActivityStreams actor type/u);
  });

  it("correlates the queued envelope with its post-verification processed receipt", () => {
    const identity = {
      activityId: "https://activitypods.example/alice/outbox/follow-1",
      canonicalRemoteActorUri: origin.canonicalRemoteActorUri,
    };
    const receipt = JSON.stringify({
      msg: "Inbound activity processed",
      envelopeId: "envelope-1",
      activityId: identity.activityId,
      actor: identity.canonicalRemoteActorUri,
      type: "Accept",
    });

    expect(hasProcessedSidecarAccept(receipt, identity, "envelope-1")).toBe(true);
    expect(hasProcessedSidecarAccept(receipt, identity, "envelope-2")).toBe(false);
    expect(hasProcessedSidecarAccept(receipt, { ...identity, activityId: `${identity.activityId}-other` }, "envelope-1"))
      .toBe(false);
  });
});
