import { describe, expect, it } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";

const translationContext: TranslationContext = {
  now: () => new Date("2026-04-03T10:00:00.000Z"),
  resolveActorRef: async (ref: CanonicalActorRef) => ({
    canonicalAccountId: ref.canonicalAccountId ?? "acct:alice",
    did: ref.did ?? "did:plc:alice",
    activityPubActorUri: ref.activityPubActorUri ?? "https://example.com/users/alice",
    handle: ref.handle ?? "alice.example.com",
    webId: ref.webId ?? "https://example.com/alice/profile/card#me",
  }),
  resolveObjectRef: async (ref: CanonicalObjectRef) => ({
    canonicalObjectId: ref.canonicalObjectId,
    atUri: ref.atUri ?? "at://did:plc:alice/app.bsky.feed.post/3knote",
    cid: ref.cid ?? null,
    activityPubObjectId: ref.activityPubObjectId ?? null,
    canonicalUrl: ref.canonicalUrl ?? null,
  }),
  resolveBlobUrl: async (did: string, cid: string) => `https://cdn.example.com/${did}/${cid}.jpg`,
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("alt-text parity", () => {
  it("maps Bluesky image embed alt text into canonical attachments", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3kalt1",
        rkey: "3kalt1",
        operation: "create",
        record: {
          $type: "app.bsky.feed.post",
          text: "An image post",
          embed: {
            $type: "app.bsky.embed.images",
            images: [
              {
                alt: "A red kite above the sea",
                image: {
                  $type: "blob",
                  ref: { $link: "bafkrei-image-1" },
                  mimeType: "image/jpeg",
                  size: 2048,
                },
                aspectRatio: {
                  width: 1200,
                  height: 800,
                },
              },
            ],
          },
          createdAt: "2026-04-03T10:00:00.000Z",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    expect(intent.content.attachments).toHaveLength(1);
    expect(intent.content.attachments[0]).toEqual(
      expect.objectContaining({
        mediaType: "image/jpeg",
        cid: "bafkrei-image-1",
        byteSize: 2048,
        alt: "A red kite above the sea",
        width: 1200,
        height: 800,
      }),
    );
  });

  it("projects canonical attachment alt text into Bluesky image embeds", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/create-note-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/1",
          type: "Note",
          content: "A photo note",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    intent.content.attachments = [
      {
        attachmentId: "https://example.com/notes/1#attachment-1",
        mediaType: "image/jpeg",
        cid: "bafkrei-image-2",
        byteSize: 4096,
        alt: "A calm mountain lake at sunrise",
        width: 1600,
        height: 900,
      },
    ];
    intent.content.linkPreview = {
      uri: "https://example.com/article",
      title: "Ignored when images exist",
      description: "Single-embed Bluesky rule",
      thumbUrl: "https://cdn.example.com/thumb.png",
    };

    const projector = new CanonicalToAtprotoProjector();
    const projected = await projector.project(intent, projectionContext);

    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    expect(projected.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_IMAGES",
        }),
      ]),
    );
    expect(projected.commands[0]?.record).toEqual(
      expect.objectContaining({
        embed: {
          $type: "app.bsky.embed.images",
          images: [
            {
              alt: "A calm mountain lake at sunrise",
              image: {
                $type: "blob",
                ref: { $link: "bafkrei-image-2" },
                mimeType: "image/jpeg",
                size: 4096,
              },
              aspectRatio: {
                width: 1600,
                height: 900,
              },
            },
          ],
        },
      }),
    );
  });
});
