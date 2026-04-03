import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { fetchOpenGraph } from "../../utils/opengraph.js";

vi.mock("../../utils/opengraph.js", () => ({
  fetchOpenGraph: vi.fn(),
}));

const mockedFetchOpenGraph = vi.mocked(fetchOpenGraph);

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
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("note link preview parity", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("translates AP notes with explicit links into canonical link previews and AT card embeds", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });

    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/note-create-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/notes/1",
          type: "Note",
          content: "<p>Check https://example.com/page for more.</p>",
        },
      },
      translationContext,
    );

    expect(mockedFetchOpenGraph).toHaveBeenCalledWith("https://example.com/page");
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    expect(intent.content.kind).toBe("note");
    expect(intent.content.linkPreview).toEqual({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });

    const projector = new CanonicalToAtprotoProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    expect(projected.commands).toHaveLength(1);
    expect(projected.commands[0]?.linkPreviewThumbUrlHint).toBe("https://cdn.example.com/page-card.png");
    expect(projected.commands[0]?.record).toEqual(
      expect.objectContaining({
        embed: {
          $type: "app.bsky.embed.external",
          external: {
            uri: "https://example.com/page",
            title: "Example Page",
            description: "Example description",
          },
        },
      }),
    );
  });

  it("preserves note link previews through AT commit replay", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });

    const translator = new AtprotoToCanonicalTranslator();
    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3knote",
        rkey: "3knote",
        operation: "update",
        record: {
          $type: "app.bsky.feed.post",
          text: "Check https://example.com/page for more.",
          facets: [
            {
              index: { byteStart: 6, byteEnd: 30 },
              features: [
                {
                  $type: "app.bsky.richtext.facet#link",
                  uri: "https://example.com/page",
                },
              ],
            },
          ],
          createdAt: "2026-04-03T10:00:00.000Z",
          embed: {
            $type: "app.bsky.embed.external",
            external: {
              uri: "https://example.com/page",
              title: "Example Page",
              description: "Example description",
              thumb: {
                $type: "blob",
                ref: { $link: "bafkrei-note-thumb" },
                mimeType: "image/png",
                size: 1024,
              },
            },
          },
        },
      },
      translationContext,
    );

    expect(mockedFetchOpenGraph).toHaveBeenCalledWith("https://example.com/page");
    expect(intent?.kind).toBe("PostEdit");
    if (!intent || intent.kind !== "PostEdit") {
      return;
    }

    expect(intent.content.linkPreview).toEqual({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });
  });
});
