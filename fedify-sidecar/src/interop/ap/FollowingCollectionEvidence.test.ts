import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The executable proof helper is intentionally plain ESM without a declaration file.
import { queryFollowingMembership } from "../../../interop/ap/scripts/assert-real-return-accept.mjs";

const origin = {
  remoteActorUri: "https://remote.example/users/bob",
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
        items: [origin.remoteActorUri],
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
});
