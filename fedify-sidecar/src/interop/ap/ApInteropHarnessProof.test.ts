import { describe, expect, it } from "vitest";

import {
  buildFollowActivity,
  extractRemoteInboxTarget,
  matchesAcceptForFollow,
  matchesRejectForFollow,
  requiresSignedActivityPubGet,
  selectActivityPubSelfLink,
} from "./lib.js";

describe("AP interop harness helpers", () => {
  it("selects the ActivityPub self link from WebFinger", () => {
    const href = selectActivityPubSelfLink({
      subject: "acct:interop@gotosocial",
      links: [
        { rel: "self", type: "application/json", href: "https://gotosocial/users/interop" },
        {
          rel: "self",
          type: "application/activity+json",
          href: "https://gotosocial/users/interop/activitypub",
        },
      ],
    });

    expect(href).toBe("https://gotosocial/users/interop/activitypub");
  });

  it("extracts inbox and shared inbox from an actor document", () => {
    expect(
      extractRemoteInboxTarget({
        id: "https://gotosocial/users/interop",
        inbox: "https://gotosocial/users/interop/inbox",
        endpoints: {
          sharedInbox: "https://gotosocial/inbox",
        },
      }),
    ).toEqual({
      actorId: "https://gotosocial/users/interop",
      inboxUrl: "https://gotosocial/users/interop/inbox",
      sharedInboxUrl: "https://gotosocial/inbox",
    });
  });

  it("matches embedded Accept activities for a Follow proof", () => {
    const follow = buildFollowActivity({
      actorUri: "https://sidecar/users/alice",
      targetActorUri: "https://gotosocial/users/interop",
      id: "https://sidecar/activities/follow-1",
    });

    expect(
      matchesAcceptForFollow(
        {
          type: "Accept",
          actor: "https://gotosocial/users/interop",
          object: {
            type: "Follow",
            id: follow.id,
            actor: follow.actor,
            object: follow.object,
          },
        },
        {
          followActivityId: follow.id,
          localActorUri: follow.actor,
          remoteActorUri: follow.object,
        },
      ),
    ).toBe(true);
  });

  it("matches string-reference Reject activities for a Follow proof", () => {
    expect(
      matchesRejectForFollow(
        {
          type: "Reject",
          actor: "https://mastodon/users/interop",
          object: "https://sidecar/activities/follow-2",
        },
        {
          followActivityId: "https://sidecar/activities/follow-2",
          localActorUri: "https://sidecar/users/alice",
          remoteActorUri: "https://mastodon/users/interop",
        },
      ),
    ).toBe(true);
  });

  it("detects discovery responses that require a signed ActivityPub GET", () => {
    expect(requiresSignedActivityPubGet(401)).toBe(true);
    expect(requiresSignedActivityPubGet(403)).toBe(true);
    expect(requiresSignedActivityPubGet(404)).toBe(false);
  });
});
