import { describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { AtprotoWriteGatewayPort } from "../adapters/AtprotoWriteGatewayPort.js";

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
    atUri: ref.atUri ?? null,
    cid: ref.cid ?? null,
    activityPubObjectId: ref.activityPubObjectId ?? null,
    canonicalUrl: ref.canonicalUrl ?? null,
  }),
  resolveBlobUrl: async (did: string, cid: string) => `https://cdn.example.com/${did}/${cid}`,
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("protocol bridge video parity", () => {
  it("translates AT video embeds into canonical attachments and projects them to ActivityPub Video attachments", async () => {
    const translator = new AtprotoToCanonicalTranslator();
    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3kvideo1",
        rkey: "3kvideo1",
        operation: "create",
        record: {
          $type: "app.bsky.feed.post",
          text: "Watch this clip",
          embed: {
            $type: "app.bsky.embed.video",
            video: {
              $type: "blob",
              ref: { $link: "bafkrei-video-1" },
              mimeType: "video/mp4",
              size: 1024,
            },
            alt: "A sample bridge video",
            aspectRatio: {
              width: 1920,
              height: 1080,
            },
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

    expect(intent.content.attachments).toEqual([
      expect.objectContaining({
        mediaType: "video/mp4",
        cid: "bafkrei-video-1",
        byteSize: 1024,
        alt: "A sample bridge video",
        width: 1920,
        height: 1080,
        url: "https://cdn.example.com/did:plc:alice/bafkrei-video-1",
      }),
    ]);

    const projector = new CanonicalToActivityPubProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    const object = projected.commands[0]?.activity["object"] as Record<string, unknown>;
    expect(object["attachment"]).toEqual([
      expect.objectContaining({
        type: "Video",
        mediaType: "video/mp4",
        url: "https://cdn.example.com/did:plc:alice/bafkrei-video-1",
        name: "A sample bridge video",
        width: 1920,
        height: 1080,
      }),
    ]);
  });

  it("projects AP video attachments to AT with attachment hints and resolves them into native video embeds", async () => {
    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/video-note-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/video-1",
          type: "Note",
          content: "<p>Bridge this video</p>",
          attachment: [
            {
              type: "Video",
              mediaType: "video/mp4",
              url: "https://media.remote.example/video.mp4",
              summary: "Remote video alt text",
              width: 1280,
              height: 720,
            },
          ],
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    intent.content.linkPreview = {
      uri: "https://example.com/articles/video-note-1",
      title: "Skipped when video exists",
      description: "AT single-embed rule",
      thumbUrl: "https://example.com/thumb.jpg",
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
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_VIDEO",
        }),
      ]),
    );

    const command = projected.commands[0]!;
    expect(command.collection).toBe("app.bsky.feed.post");
    expect(command.record?.["embed"]).toBeUndefined();
    expect(command.attachmentMediaHints).toEqual([
      expect.objectContaining({
        mediaType: "video/mp4",
        url: "https://media.remote.example/video.mp4",
        alt: "Remote video alt text",
        width: 1280,
        height: 720,
      }),
    ]);

    const writeGateway = {
      createRecord: vi.fn().mockResolvedValue({ uri: "at://did:plc:alice/app.bsky.feed.post/3kvideo2", cid: "bafy-post" }),
      putRecord: vi.fn(),
      deleteRecord: vi.fn(),
    };
    const accountResolver = {
      resolveByIdentifier: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        did: "did:plc:alice",
        handle: "alice.example.com",
        atprotoSource: "local",
        atprotoManaged: true,
      }),
    };
    const attachmentMediaResolver = {
      resolveAttachmentBlob: vi.fn().mockResolvedValue({
        $type: "blob",
        ref: { $link: "bafkrei-uploaded-video" },
        mimeType: "video/mp4",
        size: 2048,
      }),
    };

    const port = new AtprotoWriteGatewayPort(
      writeGateway as any,
      accountResolver as any,
      {
        attachmentMediaResolver,
      },
    );

    await port.apply([command]);

    expect(writeGateway.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        record: expect.objectContaining({
          embed: {
            $type: "app.bsky.embed.video",
            video: {
              $type: "blob",
              ref: { $link: "bafkrei-uploaded-video" },
              mimeType: "video/mp4",
              size: 2048,
            },
            alt: "Remote video alt text",
            aspectRatio: {
              width: 1280,
              height: 720,
            },
          },
        }),
      }),
      expect.anything(),
    );
  });
});
