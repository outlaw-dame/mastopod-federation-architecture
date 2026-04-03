import { describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";

const TARGET_AT_URI = "at://did:plc:bob/app.bsky.feed.post/3kpost";
const TARGET_AP_URI = "https://remote.example/notes/1";
const FOLLOW_SUBJECT_DID = "did:plc:bob";
const FOLLOW_SUBJECT_AP = "https://remote.example/users/bob";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-03T10:00:00.000Z"),
  resolveActorRef: async (ref: CanonicalActorRef) => {
    const did = ref.did
      ?? (ref.activityPubActorUri === FOLLOW_SUBJECT_AP ? FOLLOW_SUBJECT_DID : "did:plc:alice");
    const activityPubActorUri = ref.activityPubActorUri
      ?? (did === FOLLOW_SUBJECT_DID ? FOLLOW_SUBJECT_AP : "https://example.com/users/alice");

    return {
      canonicalAccountId:
        ref.canonicalAccountId
        ?? (did === FOLLOW_SUBJECT_DID ? "acct:bob" : "acct:alice"),
      did,
      activityPubActorUri,
      handle: ref.handle ?? (did === FOLLOW_SUBJECT_DID ? "bob.remote.example" : "alice.example.com"),
      webId: ref.webId ?? `${activityPubActorUri}#me`,
    };
  },
  resolveObjectRef: async (ref: CanonicalObjectRef) => {
    const id = ref.atUri ?? ref.activityPubObjectId ?? ref.canonicalObjectId;
    if (id === TARGET_AP_URI || id === TARGET_AT_URI || ref.canonicalObjectId === "canonical-post-1") {
      return {
        canonicalObjectId: "canonical-post-1",
        atUri: TARGET_AT_URI,
        cid: "bafy-post-1",
        activityPubObjectId: TARGET_AP_URI,
        canonicalUrl: TARGET_AP_URI,
      };
    }

    return {
      canonicalObjectId: ref.canonicalObjectId,
      atUri: ref.atUri ?? null,
      cid: ref.cid ?? null,
      activityPubObjectId: ref.activityPubObjectId ?? null,
      canonicalUrl: ref.canonicalUrl ?? null,
    };
  },
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("protocol bridge social slice", () => {
  it("translates AP Like and Undo to AT like create/delete with stable routing", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const addIntent = await translator.translate(
      {
        id: "https://example.com/activities/like-1",
        type: "Like",
        actor: "https://example.com/users/alice",
        object: TARGET_AP_URI,
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ReactionAdd");
    if (!addIntent || addIntent.kind !== "ReactionAdd") return;
    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const removeIntent = await translator.translate(
      {
        id: "https://example.com/activities/undo-like-1",
        type: "Undo",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/activities/like-1",
          type: "Like",
          actor: "https://example.com/users/alice",
          object: TARGET_AP_URI,
        },
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("ReactionRemove");
    if (!removeIntent || removeIntent.kind !== "ReactionRemove") return;
    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(addProjected.commands[0]).toEqual(
      expect.objectContaining({
        kind: "createRecord",
        collection: "app.bsky.feed.like",
        repoDid: "did:plc:alice",
      }),
    );
    expect(addProjected.commands[0]?.record?.["subject"]).toEqual({
      uri: TARGET_AT_URI,
      cid: "bafy-post-1",
    });
    expect(removeProjected.commands[0]).toEqual(
      expect.objectContaining({
        kind: "deleteRecord",
        collection: "app.bsky.feed.like",
        repoDid: "did:plc:alice",
      }),
    );
    expect(removeProjected.commands[0]?.rkey).toBe(addProjected.commands[0]?.rkey);
    expect(removeProjected.commands[0]?.canonicalRefIdHint).toBe(addProjected.commands[0]?.canonicalRefIdHint);
  });

  it("resolves AP Undo by remote activity ID through the trusted activity resolver", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();
    const resolveActivityObject = vi.fn().mockResolvedValue({
      id: "https://remote.example/activities/like-2",
      type: "Like",
      actor: "https://example.com/users/alice",
      object: TARGET_AP_URI,
    });
    const context: TranslationContext = {
      ...translationContext,
      resolveActivityObject,
    };

    const removeIntent = await translator.translate(
      {
        id: "https://example.com/activities/undo-like-2",
        type: "Undo",
        actor: "https://example.com/users/alice",
        object: "https://remote.example/activities/like-2",
      },
      context,
    );

    expect(resolveActivityObject).toHaveBeenCalledWith(
      "https://remote.example/activities/like-2",
      { expectedActorUri: "https://example.com/users/alice" },
    );
    expect(removeIntent?.kind).toBe("ReactionRemove");
    if (!removeIntent || removeIntent.kind !== "ReactionRemove") return;

    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(removeProjected.commands[0]).toEqual(
      expect.objectContaining({
        kind: "deleteRecord",
        collection: "app.bsky.feed.like",
        repoDid: "did:plc:alice",
      }),
    );
  });

  it("rejects AP Undo resolution when the resolved activity actor mismatches the outer Undo actor", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const resolveActivityObject = vi.fn().mockResolvedValue({
      id: "https://remote.example/activities/repost-bad",
      type: "Announce",
      actor: "https://remote.example/users/mallory",
      object: TARGET_AP_URI,
    });
    const context: TranslationContext = {
      ...translationContext,
      resolveActivityObject,
    };

    const removeIntent = await translator.translate(
      {
        id: "https://example.com/activities/undo-repost-bad",
        type: "Undo",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://remote.example/activities/repost-bad",
        },
      },
      context,
    );

    expect(resolveActivityObject).toHaveBeenCalledWith(
      "https://remote.example/activities/repost-bad",
      { expectedActorUri: "https://example.com/users/alice" },
    );
    expect(removeIntent).toBeNull();
  });

  it("translates AP Announce and Undo to AT repost create/delete with stable routing", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const addIntent = await translator.translate(
      {
        id: "https://example.com/activities/repost-1",
        type: "Announce",
        actor: "https://example.com/users/alice",
        object: TARGET_AP_URI,
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ShareAdd");
    if (!addIntent || addIntent.kind !== "ShareAdd") return;
    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const removeIntent = await translator.translate(
      {
        id: "https://example.com/activities/undo-repost-1",
        type: "Undo",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/activities/repost-1",
          type: "Announce",
          actor: "https://example.com/users/alice",
          object: TARGET_AP_URI,
        },
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("ShareRemove");
    if (!removeIntent || removeIntent.kind !== "ShareRemove") return;
    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(addProjected.commands[0]?.collection).toBe("app.bsky.feed.repost");
    expect(removeProjected.commands[0]?.collection).toBe("app.bsky.feed.repost");
    expect(removeProjected.commands[0]?.rkey).toBe(addProjected.commands[0]?.rkey);
  });

  it("translates AP Follow and Undo to AT follow create/delete with stable routing", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const addIntent = await translator.translate(
      {
        id: "https://example.com/activities/follow-1",
        type: "Follow",
        actor: "https://example.com/users/alice",
        object: FOLLOW_SUBJECT_AP,
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("FollowAdd");
    if (!addIntent || addIntent.kind !== "FollowAdd") return;
    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const removeIntent = await translator.translate(
      {
        id: "https://example.com/activities/undo-follow-1",
        type: "Undo",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/activities/follow-1",
          type: "Follow",
          actor: "https://example.com/users/alice",
          object: FOLLOW_SUBJECT_AP,
        },
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("FollowRemove");
    if (!removeIntent || removeIntent.kind !== "FollowRemove") return;
    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(addProjected.commands[0]?.collection).toBe("app.bsky.graph.follow");
    expect(addProjected.commands[0]?.record?.["subject"]).toBe(FOLLOW_SUBJECT_DID);
    expect(removeProjected.commands[0]?.collection).toBe("app.bsky.graph.follow");
    expect(removeProjected.commands[0]?.rkey).toBe(addProjected.commands[0]?.rkey);
  });

  it("translates AT like create/delete envelopes to AP Like and Undo", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const addIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.like/3klike",
        rkey: "3klike",
        operation: "create",
        bridge: {
          originProtocol: "atproto",
          originEventId: "at://did:plc:alice/app.bsky.feed.like/3klike",
          projectionMode: "native",
        },
        record: {
          $type: "app.bsky.feed.like",
          subject: {
            uri: TARGET_AT_URI,
            cid: "bafy-post-1",
          },
          createdAt: "2026-04-03T12:00:00.000Z",
        },
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ReactionAdd");
    if (!addIntent || addIntent.kind !== "ReactionAdd") return;
    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const removeIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.like/3klike",
        rkey: "3klike",
        collection: "app.bsky.feed.like",
        operation: "delete",
        subjectUri: TARGET_AT_URI,
        subjectCid: "bafy-post-1",
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("ReactionRemove");
    if (!removeIntent || removeIntent.kind !== "ReactionRemove") return;
    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(addProjected.commands[0]?.targetTopic).toBe("ap.atproto-ingress.v1");
    expect(addProjected.commands[0]?.activity["type"]).toBe("Like");
    expect(addProjected.commands[0]?.activity["object"]).toBe(TARGET_AP_URI);
    expect(removeProjected.commands[0]?.activity["type"]).toBe("Undo");
    expect((removeProjected.commands[0]?.activity["object"] as Record<string, unknown>)["type"]).toBe("Like");
  });

  it("translates AT repost create/delete envelopes to AP Announce and Undo", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const addIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.repost/3krepost",
        rkey: "3krepost",
        operation: "create",
        record: {
          $type: "app.bsky.feed.repost",
          subject: {
            uri: TARGET_AT_URI,
            cid: "bafy-post-1",
          },
          createdAt: "2026-04-03T12:01:00.000Z",
        },
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ShareAdd");
    if (!addIntent || addIntent.kind !== "ShareAdd") return;
    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const removeIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.repost/3krepost",
        rkey: "3krepost",
        collection: "app.bsky.feed.repost",
        operation: "delete",
        subjectUri: TARGET_AT_URI,
        subjectCid: "bafy-post-1",
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("ShareRemove");
    if (!removeIntent || removeIntent.kind !== "ShareRemove") return;
    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(addProjected.commands[0]?.activity["type"]).toBe("Announce");
    expect(removeProjected.commands[0]?.activity["type"]).toBe("Undo");
    expect((removeProjected.commands[0]?.activity["object"] as Record<string, unknown>)["type"]).toBe("Announce");
  });

  it("translates AT follow create/delete envelopes to AP Follow and Undo", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const addIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.graph.follow/3kfollow",
        rkey: "3kfollow",
        operation: "create",
        record: {
          $type: "app.bsky.graph.follow",
          subject: FOLLOW_SUBJECT_DID,
          createdAt: "2026-04-03T12:02:00.000Z",
        },
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("FollowAdd");
    if (!addIntent || addIntent.kind !== "FollowAdd") return;
    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const removeIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.graph.follow/3kfollow",
        rkey: "3kfollow",
        collection: "app.bsky.graph.follow",
        operation: "delete",
        subjectDid: FOLLOW_SUBJECT_DID,
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("FollowRemove");
    if (!removeIntent || removeIntent.kind !== "FollowRemove") return;
    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(addProjected.commands[0]?.activity["type"]).toBe("Follow");
    expect(addProjected.commands[0]?.activity["object"]).toBe(FOLLOW_SUBJECT_AP);
    expect(removeProjected.commands[0]?.activity["type"]).toBe("Undo");
    expect((removeProjected.commands[0]?.activity["object"] as Record<string, unknown>)["type"]).toBe("Follow");
  });
});
