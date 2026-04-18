import { describe, expect, it } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-18T10:00:00.000Z"),
  resolveActorRef: async (ref: CanonicalActorRef) => ({
    canonicalAccountId: ref.canonicalAccountId ?? "acct:alice",
    did: ref.did ?? "did:plc:alice",
    activityPubActorUri: ref.activityPubActorUri ?? "https://example.com/users/alice",
    handle: ref.handle ?? "alice.example.com",
    webId: ref.webId ?? "https://example.com/users/alice#me",
  }),
  resolveObjectRef: async (ref: CanonicalObjectRef) => ({
    canonicalObjectId: ref.canonicalObjectId,
    atUri: ref.atUri ?? null,
    cid: ref.cid ?? null,
    activityPubObjectId: ref.activityPubObjectId ?? (ref.canonicalObjectId.startsWith("http")
      ? ref.canonicalObjectId
      : null),
    canonicalUrl: ref.canonicalUrl ?? (ref.canonicalObjectId.startsWith("http")
      ? ref.canonicalObjectId
      : null),
  }),
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("ActivityPub custom emoji round-trip", () => {
  it("preserves custom emoji tags on notes", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          {
            toot: "http://joinmastodon.org/ns#",
            Emoji: "toot:Emoji",
          },
        ],
        id: "https://example.com/activities/create-note-emoji",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/emoji-note",
          type: "Note",
          attributedTo: "https://example.com/users/alice",
          content: "<p>Hello :blobcat:</p>",
          published: "2026-04-18T10:00:00.000Z",
          url: "https://example.com/notes/emoji-note",
          tag: [
            {
              id: "https://example.com/emojis/blobcat",
              type: "Emoji",
              name: ":blobcat:",
              icon: {
                type: "Image",
                mediaType: "image/png",
                url: "https://example.com/media/blobcat.png",
              },
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") return;
    expect(intent.content.customEmojis).toEqual([
      expect.objectContaining({
        shortcode: ":blobcat:",
        emojiId: "https://example.com/emojis/blobcat",
        iconUrl: "https://example.com/media/blobcat.png",
      }),
    ]);

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    const activity = projected.commands[0]?.activity as Record<string, unknown>;
    const object = activity["object"] as Record<string, unknown>;
    expect(Array.isArray(activity["@context"])).toBe(true);
    expect((activity["@context"] as Array<unknown>).some(
      (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>)["Emoji"] === "toot:Emoji",
    )).toBe(true);
    expect(object["tag"]).toEqual([
      expect.objectContaining({
        type: "Emoji",
        name: ":blobcat:",
        id: "https://example.com/emojis/blobcat",
      }),
    ]);
  });

  it("preserves custom emoji tags on profile updates", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          {
            toot: "http://joinmastodon.org/ns#",
            Emoji: "toot:Emoji",
          },
        ],
        id: "https://example.com/activities/update-profile-emoji",
        type: "Update",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/users/alice",
          type: "Person",
          name: "Alice :blobcat:",
          summary: "<p>Profile bio</p>",
          updated: "2026-04-18T10:00:00.000Z",
          url: "https://example.com/users/alice",
          tag: [
            {
              id: "https://example.com/emojis/blobcat",
              type: "Emoji",
              name: ":blobcat:",
              icon: {
                type: "Image",
                mediaType: "image/png",
                url: "https://example.com/media/blobcat.png",
              },
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("ProfileUpdate");
    if (!intent || intent.kind !== "ProfileUpdate") return;
    expect(intent.content.customEmojis).toEqual([
      expect.objectContaining({
        shortcode: ":blobcat:",
      }),
    ]);

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") return;

    const activity = projected.commands[0]?.activity as Record<string, unknown>;
    const object = activity["object"] as Record<string, unknown>;
    expect(Array.isArray(activity["@context"])).toBe(true);
    expect((object["tag"] as Array<unknown>)[0]).toEqual(
      expect.objectContaining({
        type: "Emoji",
        name: ":blobcat:",
      }),
    );
  });
});
