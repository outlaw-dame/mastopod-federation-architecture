import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
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
  resolveObjectRef: async (ref: CanonicalObjectRef) => {
    const canonicalId = ref.canonicalObjectId;
    const articleAtUri = canonicalId === "https://example.com/articles/1"
      ? "at://did:plc:alice/site.standard.document/3karticle"
      : null;
    return {
      canonicalObjectId: canonicalId,
      atUri: ref.atUri ?? articleAtUri,
      cid: ref.cid ?? null,
      activityPubObjectId: ref.activityPubObjectId ?? null,
      canonicalUrl: ref.canonicalUrl ?? (/^https?:\/\//.test(canonicalId) ? canonicalId : null),
    };
  },
};

const projectionContext: ProjectionContext = {
  ...translationContext,
  buildIntentId: buildCanonicalIntentId,
};

describe("article link preview parity", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
  });

  it("translates AP articles into canonical link previews and AT teaser embeds", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/articles/1",
      title: "Bridge Article",
      description: "Canonical bridge article preview",
      thumbUrl: "https://cdn.example.com/article-1.jpg",
    });

    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/article-create-1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/articles/1",
          type: "Article",
          name: "Bridge Article",
          summary: "Canonical bridge article preview",
          url: "https://example.com/articles/1",
          content: "<p>This is the longform article body.</p>",
        },
      },
      translationContext,
    );

    expect(mockedFetchOpenGraph).toHaveBeenCalledWith("https://example.com/articles/1");
    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    expect(intent.content.linkPreview).toEqual({
      uri: "https://example.com/articles/1",
      title: "Bridge Article",
      description: "Canonical bridge article preview",
      thumbUrl: "https://cdn.example.com/article-1.jpg",
    });

    const projector = new CanonicalToAtprotoProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    expect(projected.commands.map((command) => command.collection)).toEqual([
      "site.standard.document",
      "app.bsky.feed.post",
    ]);

    const teaserRecord = projected.commands[1]?.record as Record<string, unknown>;
    expect(teaserRecord["embed"]).toEqual({
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://example.com/articles/1",
        title: "Bridge Article",
        description: "Canonical bridge article preview",
      },
    });
    expect(teaserRecord["facets"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          features: [
            expect.objectContaining({
              $type: "app.bsky.richtext.facet#link",
              uri: "https://example.com/articles/1",
            }),
          ],
        }),
      ]),
    );
  });

  it("keeps article teaser previews on AP article updates projected to AT", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/articles/1",
      title: "Bridge Article Updated",
      description: "Updated bridge article preview",
      thumbUrl: "https://cdn.example.com/article-1-updated.jpg",
    });

    const translator = new ActivityPubToCanonicalTranslator();
    const intent = await translator.translate(
      {
        id: "https://example.com/activities/article-update-1",
        type: "Update",
        actor: "https://example.com/users/alice",
        object: {
          id: "https://example.com/articles/1",
          type: "Article",
          name: "Bridge Article Updated",
          summary: "Updated bridge article preview",
          url: "https://example.com/articles/1",
          content: "<p>The updated longform article body.</p>",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostEdit");
    if (!intent || intent.kind !== "PostEdit") {
      return;
    }

    const projector = new CanonicalToAtprotoProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    expect(projected.commands.map((command) => command.kind)).toEqual([
      "updateRecord",
      "updateRecord",
    ]);

    const teaserRecord = projected.commands[1]?.record as Record<string, unknown>;
    expect(teaserRecord["embed"]).toEqual({
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://example.com/articles/1",
        title: "Bridge Article Updated",
        description: "Updated bridge article preview",
      },
    });
  });

  it("projects AT article previews to ActivityPub Article icons", async () => {
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/articles/1",
      title: "Bridge Article",
      description: "Canonical bridge article preview",
      thumbUrl: "https://cdn.example.com/article-1.jpg",
    });

    const translator = new AtprotoToCanonicalTranslator();
    const intent = await translator.translate(
      {
        repoDid: "did:plc:alice",
        uri: "at://did:plc:alice/site.standard.document/3karticle",
        rkey: "3karticle",
        operation: "create",
        record: {
          $type: "site.standard.document",
          title: "Bridge Article",
          summary: "Canonical bridge article preview",
          text: "Longform body",
          url: "https://example.com/articles/1",
        },
      },
      translationContext,
    );

    expect(intent?.kind).toBe("PostCreate");
    if (!intent || intent.kind !== "PostCreate") {
      return;
    }

    const projector = new CanonicalToActivityPubProjector();
    const projected = await projector.project(intent, projectionContext);
    expect(projected.kind).toBe("success");
    if (projected.kind !== "success") {
      return;
    }

    const activityObject = projected.commands[0]?.activity["object"] as Record<string, unknown>;
    expect(activityObject["type"]).toBe("Article");
    expect(activityObject["icon"]).toEqual({
      type: "Image",
      url: "https://cdn.example.com/article-1.jpg",
      name: "Bridge Article",
    });
  });
});
