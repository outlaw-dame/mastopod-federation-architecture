import { describe, expect, it } from "vitest";
import { isMatchingNativeInboundAccept } from "../../../interop/ap/scripts/assert-real-native-inbound-accept.mjs";

const origin = {
  activityId: "https://activitypods.test/alice/follows/1",
  actorUri: "https://activitypods.test/alice",
  remoteActorUri: "https://remote.test/users/bob",
};
const canonicalRemoteActorUri = "https://remote.test/ap/users/123";
const receipt = {
  schema: "ap.real-inbound-api-call.v1",
  method: "POST",
  path: "/alice/inbox",
  responseStatus: 202,
  bodyBytes: 321,
  bodySha256Base64: "proof-sha",
  activityId: "https://remote.test/accept/1",
  activityType: "Accept",
  actorUri: canonicalRemoteActorUri,
  objectId: origin.activityId,
  objectType: "Follow",
  objectActorUri: origin.actorUri,
  objectTargetUri: canonicalRemoteActorUri,
};

describe("native inbound Accept assertion", () => {
  it("binds a successful ActivityPods receipt to the exact outgoing Follow and canonical remote actor", () => {
    expect(isMatchingNativeInboundAccept(receipt, origin, canonicalRemoteActorUri, "remote.test")).toBe(true);
  });

  it.each([
    { objectId: "https://activitypods.test/alice/follows/other" },
    { objectActorUri: "https://activitypods.test/mallory" },
    { objectTargetUri: origin.remoteActorUri },
    { actorUri: "https://evil.test/users/bob" },
    { responseStatus: 401 },
  ])("rejects an uncorrelated or unsuccessful receipt %o", overrides => {
    expect(isMatchingNativeInboundAccept({ ...receipt, ...overrides }, origin, canonicalRemoteActorUri, "remote.test")).toBe(false);
  });
});
