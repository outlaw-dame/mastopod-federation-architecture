import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { normalizeActivityPubNoteLinkPreviewMode } from "../projectors/activitypub/ActivityPubProjectionPolicy.js";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
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
    atUri: ref.atUri ?? null,
    cid: ref.cid ?? null,
    activityPubObjectId: ref.activityPubObjectId ?? null,
    canonicalUrl: ref.canonicalUrl ?? null,
  }),
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("AP-side note link preview parity", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("projects AT note link previews conservatively by default as attachment cards without preview", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });

    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector();

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3knote",
        rkey: "3knote",
        operation: "create",
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

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Create",
        object: expect.objectContaining({
          type: "Note",
          attachment: expect.arrayContaining([
            expect.objectContaining({
              type: "Document",
              mediaType: "text/html",
              url: "https://example.com/page",
              name: "Example Page",
            }),
          ]),
        }),
      }),
    );
    const object = projected.commands[0]?.activity["object"] as Record<string, unknown>;
    expect(object["preview"]).toBeUndefined();
    expect(projected.commands[0]?.metadata).toEqual(
      expect.objectContaining({
        activityPubHints: {
          noteLinkPreviewUrls: ["https://example.com/page"],
        },
      }),
    );
  });

  it("projects AT note link previews with explicit preview objects in rich mode", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });

    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector({
      noteLinkPreviewMode: "attachment_and_preview",
    });

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3knote",
        rkey: "3knote",
        operation: "create",
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
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    expect(projected.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Create",
        object: expect.objectContaining({
          type: "Note",
          preview: expect.objectContaining({
            type: "Document",
            mediaType: "text/html",
            url: "https://example.com/page",
            name: "Example Page",
            summary: "Example description",
          }),
        }),
      }),
    );
  });

  it("normalizes AP note preview policy aliases safely", () => {
    expect(normalizeActivityPubNoteLinkPreviewMode(undefined)).toBe("attachment_only");
    expect(normalizeActivityPubNoteLinkPreviewMode("mastodon-safe")).toBe("attachment_only");
    expect(normalizeActivityPubNoteLinkPreviewMode("rich")).toBe("attachment_and_preview");
    expect(normalizeActivityPubNoteLinkPreviewMode("none")).toBe("disabled");
    expect(normalizeActivityPubNoteLinkPreviewMode("not-a-real-mode")).toBe("attachment_only");
  });

  it("omits AP-side note preview cards entirely when disabled", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/page",
      title: "Example Page",
      description: "Example description",
      thumbUrl: "https://cdn.example.com/page-card.png",
    });

    const translator = new AtprotoToCanonicalTranslator();
    const projector = new CanonicalToActivityPubProjector({
      noteLinkPreviewMode: "disabled",
    });

    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/app.bsky.feed.post/3knote",
        rkey: "3knote",
        operation: "create",
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
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    const object = projected.commands[0]?.activity["object"] as Record<string, unknown>;
    expect(object["preview"]).toBeUndefined();
    expect(object["attachment"]).toBeUndefined();
  });
});
