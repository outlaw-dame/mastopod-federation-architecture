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

  it("translates AP emoji reactions to the ActivityPods AT lexicon with custom emoji metadata", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToAtprotoProjector();

    const addIntent = await translator.translate(
      {
        id: "https://example.com/activities/emoji-react-1",
        type: "EmojiReact",
        actor: "https://example.com/users/alice",
        object: TARGET_AP_URI,
        content: " :blobcat: ",
        tag: [
          {
            type: "Emoji",
            id: "https://emoji.example/blobcat",
            name: "blobcat",
            icon: {
              type: "Image",
              mediaType: "image/png",
              url: "https://emoji.example/blobcat.png",
            },
          },
        ],
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ReactionAdd");
    if (!addIntent || addIntent.kind !== "ReactionAdd") return;
    expect(addIntent.reactionType).toBe("emoji");
    expect(addIntent.reactionContent).toBe(":blobcat:");
    expect(addIntent.reactionEmoji?.shortcode).toBe(":blobcat:");
    expect(addIntent.reactionEmoji?.iconUrl).toBe("https://emoji.example/blobcat.png");

    const projected = await projector.project(addIntent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;
    expect(projected.commands[0]).toEqual(
      expect.objectContaining({
        kind: "createRecord",
        collection: "org.activitypods.emojiReaction",
        repoDid: "did:plc:alice",
      }),
    );
    expect(projected.commands[0]?.record).toEqual(
      expect.objectContaining({
        $type: "org.activitypods.emojiReaction",
        subject: {
          uri: TARGET_AT_URI,
          cid: "bafy-post-1",
        },
        reaction: ":blobcat:",
        emoji: expect.objectContaining({
          shortcode: ":blobcat:",
          emojiId: "https://emoji.example/blobcat",
          icon: expect.objectContaining({
            uri: "https://emoji.example/blobcat.png",
            mediaType: "image/png",
          }),
          domain: "emoji.example",
        }),
      }),
    );
  });

  it("translates Like+unicode and Undo{EmojiReact} into canonical emoji reactions", async () => {
    const translator = new ActivityPubToCanonicalTranslator();

    const addIntent = await translator.translate(
      {
        id: "https://example.com/activities/emoji-like-1",
        type: "Like",
        actor: "https://example.com/users/alice",
        object: TARGET_AP_URI,
        content: " 🔥 ",
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ReactionAdd");
    if (!addIntent || addIntent.kind !== "ReactionAdd") return;
    expect(addIntent.reactionType).toBe("emoji");
    expect(addIntent.reactionContent).toBe("🔥");
    expect(addIntent.reactionEmoji).toBeNull();

    const removeIntent = await translator.translate(
      {
        id: "https://example.com/activities/undo-emoji-react-1",
        type: "Undo",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/activities/emoji-react-1",
          type: "EmojiReact",
          actor: "https://example.com/users/alice",
          object: TARGET_AP_URI,
          content: ":party_parrot:",
          tag: [
            {
              type: "Emoji",
              name: ":party_parrot:",
              icon: {
                type: "Image",
                url: "https://emoji.example/party-parrot.png",
              },
            },
          ],
        },
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("ReactionRemove");
    if (!removeIntent || removeIntent.kind !== "ReactionRemove") return;
    expect(removeIntent.reactionType).toBe("emoji");
    expect(removeIntent.reactionContent).toBe(":party_parrot:");
    expect(removeIntent.reactionEmoji?.shortcode).toBe(":party_parrot:");
  });

  it("projects different emoji reactions to distinct AP activity ids", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const fireIntent = await translator.translate(
      {
        id: "https://example.com/activities/fire-react",
        type: "Like",
        actor: "https://example.com/users/alice",
        object: TARGET_AP_URI,
        content: "🔥",
      },
      translationContext,
    );
    const partyIntent = await translator.translate(
      {
        id: "https://example.com/activities/party-react",
        type: "EmojiReact",
        actor: "https://example.com/users/alice",
        object: TARGET_AP_URI,
        content: ":party_parrot:",
        tag: [
          {
            type: "Emoji",
            id: "https://emoji.example/party-parrot",
            name: ":party_parrot:",
            icon: {
              type: "Image",
              mediaType: "image/png",
              url: "https://emoji.example/party-parrot.png",
            },
          },
        ],
      },
      translationContext,
    );

    expect(fireIntent?.kind).toBe("ReactionAdd");
    expect(partyIntent?.kind).toBe("ReactionAdd");
    if (!fireIntent || fireIntent.kind !== "ReactionAdd" || !partyIntent || partyIntent.kind !== "ReactionAdd") {
      return;
    }

    const fireProjected = await projector.project(fireIntent, projectionContext);
    const partyProjected = await projector.project(partyIntent, projectionContext);
    expect(fireProjected.kind).toBe("success");
    expect(partyProjected.kind).toBe("success");
    if (fireProjected.kind !== "success" || partyProjected.kind !== "success") return;

    const fireActivity = fireProjected.commands[0]?.activity as Record<string, unknown>;
    const partyActivity = partyProjected.commands[0]?.activity as Record<string, unknown>;
    expect(fireActivity["type"]).toBe("EmojiReact");
    expect(partyActivity["type"]).toBe("EmojiReact");
    expect(fireActivity["id"]).not.toBe(partyActivity["id"]);
    expect(partyActivity["tag"]).toEqual([
      expect.objectContaining({
        type: "Emoji",
        name: ":party_parrot:",
      }),
    ]);
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

  it("translates ActivityPods AT emoji reaction create/delete envelopes to AP EmojiReact and Undo", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const addIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/org.activitypods.emojiReaction/3kemoji",
        rkey: "3kemoji",
        operation: "create",
        bridge: {
          originProtocol: "atproto",
          originEventId: "at://did:plc:alice/org.activitypods.emojiReaction/3kemoji",
          projectionMode: "native",
        },
        record: {
          $type: "org.activitypods.emojiReaction",
          subject: {
            uri: TARGET_AT_URI,
            cid: "bafy-post-1",
          },
          reaction: ":party_parrot:",
          emoji: {
            shortcode: ":party_parrot:",
            emojiId: "https://emoji.example/party-parrot",
            icon: {
              uri: "https://emoji.example/party-parrot.png",
              mediaType: "image/png",
            },
            domain: "emoji.example",
          },
          createdAt: "2026-04-03T12:00:00.000Z",
        },
      },
      translationContext,
    );

    expect(addIntent?.kind).toBe("ReactionAdd");
    if (!addIntent || addIntent.kind !== "ReactionAdd") return;
    expect(addIntent.reactionType).toBe("emoji");
    expect(addIntent.reactionContent).toBe(":party_parrot:");
    expect(addIntent.reactionEmoji).toEqual(
      expect.objectContaining({
        shortcode: ":party_parrot:",
        iconUrl: "https://emoji.example/party-parrot.png",
      }),
    );

    const addProjected = await projector.project(addIntent, projectionContext);
    expect(addProjected.kind).toBe("success");
    if (addProjected.kind !== "success") return;

    const addActivity = addProjected.commands[0]?.activity as Record<string, unknown>;
    expect(addActivity["type"]).toBe("EmojiReact");
    expect(addActivity["content"]).toBe(":party_parrot:");
    expect(addActivity["object"]).toBe(TARGET_AP_URI);
    expect(addActivity["tag"]).toEqual([
      expect.objectContaining({
        type: "Emoji",
        name: ":party_parrot:",
        id: "https://emoji.example/party-parrot",
      }),
    ]);

    const removeIntent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/org.activitypods.emojiReaction/3kemoji",
        rkey: "3kemoji",
        collection: "org.activitypods.emojiReaction",
        operation: "delete",
        subjectUri: TARGET_AT_URI,
        subjectCid: "bafy-post-1",
        reactionContent: ":party_parrot:",
        reactionEmoji: {
          shortcode: ":party_parrot:",
          emojiId: "https://emoji.example/party-parrot",
          icon: {
            uri: "https://emoji.example/party-parrot.png",
            mediaType: "image/png",
          },
          domain: "emoji.example",
        },
      },
      translationContext,
    );

    expect(removeIntent?.kind).toBe("ReactionRemove");
    if (!removeIntent || removeIntent.kind !== "ReactionRemove") return;
    expect(removeIntent.reactionType).toBe("emoji");

    const removeProjected = await projector.project(removeIntent, projectionContext);
    expect(removeProjected.kind).toBe("success");
    if (removeProjected.kind !== "success") return;

    expect(removeProjected.commands[0]?.activity["type"]).toBe("Undo");
    expect((removeProjected.commands[0]?.activity["object"] as Record<string, unknown>)["type"]).toBe("EmojiReact");
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
