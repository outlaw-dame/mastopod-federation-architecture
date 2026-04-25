import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";
import type { ProjectionContext, TranslationContext } from "../ports/ProtocolBridgePorts.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import { ActivityPubToCanonicalTranslator } from "../activitypub/ActivityPubToCanonicalTranslator.js";
import { AtprotoToCanonicalTranslator } from "../atproto/AtprotoToCanonicalTranslator.js";
import { CanonicalToActivityPubProjector } from "../projectors/CanonicalToActivityPubProjector.js";
import { CanonicalToAtprotoProjector } from "../projectors/CanonicalToAtprotoProjector.js";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";
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

describe("article update round-trip proof", () => {
  beforeEach(() => {
    mockedFetchOpenGraph.mockReset();
    mockedFetchOpenGraph.mockResolvedValue({
      uri: "https://example.com/articles/1",
      title: "Bridge Article Updated",
      description: "Updated bridge article preview",
      thumbUrl: "https://cdn.example.com/article-1-updated.jpg",
    });
  });

  it("keeps preview-bearing AP article updates stable through AT upsert and persisted commit replay", async () => {
    const apTranslator = new ActivityPubToCanonicalTranslator();
    const canonicalIntent = await apTranslator.translate(
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

    expect(canonicalIntent?.kind).toBe("PostEdit");
    if (!canonicalIntent || canonicalIntent.kind !== "PostEdit") {
      return;
    }

    const atProjector = new CanonicalToAtprotoProjector();
    const projectedToAt = await atProjector.project(canonicalIntent, projectionContext);
    expect(projectedToAt.kind).toBe("success");
    if (projectedToAt.kind !== "success") {
      return;
    }

    const articleCommand = projectedToAt.commands.find(
      (command) => command.collection === "site.standard.document",
    );
    const teaserCommand = projectedToAt.commands.find(
      (command) => command.collection === "app.bsky.feed.post",
    );
    expect(articleCommand?.kind).toBe("updateRecord");
    expect(teaserCommand?.kind).toBe("updateRecord");
    expect((teaserCommand?.record as Record<string, unknown>)["embed"]).toEqual({
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://example.com/articles/1",
        title: "Bridge Article Updated",
        description: "Updated bridge article preview",
      },
    });

    const projectionWorker = {
      onPostUpdated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "https://example.com/articles/1",
        canonicalType: "article",
        did: "did:plc:alice",
        collection: "site.standard.document",
        rkey: "3karticle",
        atUri: "at://did:plc:alice/site.standard.document/3karticle",
        cid: "bafy-article",
        lastRev: "7",
        canonicalUrl: "https://example.com/articles/1",
        createdAt: "2026-04-03T10:00:00.000Z",
        updatedAt: "2026-04-03T10:00:00.000Z",
      }),
      listByDid: vi.fn(),
    };
    const resultStore = {
      publishResult: vi.fn().mockResolvedValue(undefined),
    };
    const identityRepo = {
      getByCanonicalAccountId: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        atprotoDid: "did:plc:alice",
      }),
    };

    const writeService = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
    });

    await writeService.applyClientMutation({
      clientMutationId: "mutation-article-update-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        _operation: "update",
        _atRepo: articleCommand?.repoDid,
        _collection: articleCommand?.collection,
        _rkey: articleCommand?.rkey,
        _bridgeCanonicalRefId: articleCommand?.canonicalRefIdHint,
        _bridgeMetadata: articleCommand?.metadata,
        ...((articleCommand?.record ?? {}) as Record<string, unknown>),
      },
      submittedAt: "2026-04-03T12:00:00.000Z",
      source: "xrpc_client",
    });

    expect(projectionWorker.onPostUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPost: expect.objectContaining({
          id: "https://example.com/articles/1",
          kind: "article",
          title: "Bridge Article Updated",
          canonicalUrl: "https://example.com/articles/1",
        }),
        atRecord: {
          collection: "site.standard.document",
          rkey: "3karticle",
        },
        bridge: expect.objectContaining({
          canonicalIntentId: canonicalIntent.canonicalIntentId,
        }),
      }),
    );

    const atTranslator = new AtprotoToCanonicalTranslator();
    const replayIntent = await atTranslator.translate(
      {
        did: "did:plc:alice",
        eventType: "#commit",
        commit: {
          operation: "update",
          collection: "site.standard.document",
          rkey: "3karticle",
          cid: "bafy-article",
          canonicalRefId: "https://example.com/articles/1",
          bridge: articleCommand?.metadata,
          record: articleCommand?.record,
        },
      },
      translationContext,
    );

    expect(replayIntent?.kind).toBe("PostEdit");
    if (!replayIntent || replayIntent.kind !== "PostEdit") {
      return;
    }

    const apProjector = new CanonicalToActivityPubProjector();
    const projectedBackToAp = await apProjector.project(replayIntent, projectionContext);
    expect(projectedBackToAp.kind).toBe("success");
    if (projectedBackToAp.kind !== "success") {
      return;
    }

    expect(projectedBackToAp.commands[0]?.activity).toEqual(
      expect.objectContaining({
        type: "Update",
        object: expect.objectContaining({
          id: "https://example.com/articles/1",
          url: "https://example.com/articles/1",
          icon: {
            type: "Image",
            url: "https://cdn.example.com/article-1-updated.jpg",
            name: "Bridge Article Updated",
          },
        }),
      }),
    );
  });
});
