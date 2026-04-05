import { describe, expect, it, vi } from "vitest";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";

describe("native AT post edit bridge write path", () => {
  it("routes bridged AT putRecord mutations into canonical post update events", async () => {
    const projectionWorker = {
      onPostUpdated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "canonical-post-1",
        atUri: "at://did:plc:alice/app.bsky.feed.post/3kpost",
        cid: "bafy-post-1",
        lastRev: "4",
      }),
      listByDid: vi.fn().mockResolvedValue([
        {
          canonicalRefId: "canonical-post-1",
          canonicalType: "post",
          did: "did:plc:alice",
          collection: "app.bsky.feed.post",
          rkey: "3kpost",
          atUri: "at://did:plc:alice/app.bsky.feed.post/3kpost",
          createdAt: "2026-04-03T10:00:00.000Z",
          updatedAt: "2026-04-03T10:00:00.000Z",
        },
      ]),
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

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-post-update-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        _operation: "update",
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _rkey: "3kpost",
        _bridgeMetadata: {
          canonicalIntentId: "intent-post-update-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/update-note-1",
            mirroredFromCanonicalIntentId: "intent-post-update-1",
            projectionMode: "mirrored",
          },
        },
        text: "Updated post body",
        createdAt: "2026-04-03T12:00:00.000Z",
      },
      submittedAt: "2026-04-03T12:00:00.000Z",
      source: "xrpc_client",
    });

    expect(aliasStore.listByDid).toHaveBeenCalledWith("did:plc:alice");
    expect(projectionWorker.onPostUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPost: expect.objectContaining({
          id: "canonical-post-1",
          bodyPlaintext: "Updated post body",
        }),
        atRecord: {
          collection: "app.bsky.feed.post",
          rkey: "3kpost",
        },
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-post-update-1",
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-post-update-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/app.bsky.feed.post/3kpost",
      }),
    );
  });

  it("routes bridged AT delete mutations with explicit canonical ids even when alias lookup is unavailable", async () => {
    const projectionWorker = {
      onPostDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      listByDid: vi.fn(),
    };
    const resultStore = {
      publishResult: vi.fn(),
    };

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: {} as any,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-post-delete-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_delete",
      payload: {
        _operation: "delete",
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _rkey: "3kpost",
        _bridgeCanonicalRefId: "canonical-post-1",
        _bridgeMetadata: {
          canonicalIntentId: "intent-post-delete-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/delete-note-1",
            mirroredFromCanonicalIntentId: "intent-post-delete-1",
            projectionMode: "mirrored",
          },
        },
      },
      submittedAt: "2026-04-03T12:30:00.000Z",
      source: "xrpc_client",
    });

    expect(aliasStore.listByDid).not.toHaveBeenCalled();
    expect(projectionWorker.onPostDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPostId: "canonical-post-1",
        canonicalAuthorId: "acct:alice",
        atRecord: {
          collection: "app.bsky.feed.post",
          rkey: "3kpost",
        },
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-post-delete-1",
        }),
      }),
    );
  });

  it("routes bridged AT article teaser upserts with explicit canonical ids even when teaser alias lookup is unavailable", async () => {
    const projectionWorker = {
      onPostUpdated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue(null),
      listByDid: vi.fn(),
    };
    const resultStore = {
      publishResult: vi.fn(),
    };

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: {} as any,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-article-teaser-update-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        _operation: "update",
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _rkey: "teaser12345ab",
        _bridgeCanonicalRefId: "https://example.com/articles/bridge::teaser",
        _bridgeMetadata: {
          canonicalIntentId: "intent-article-teaser-update-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/update-article-1",
            mirroredFromCanonicalIntentId: "intent-article-teaser-update-1",
            projectionMode: "mirrored",
          },
        },
        text: "Updated article teaser",
        createdAt: "2026-04-03T12:05:00.000Z",
      },
      submittedAt: "2026-04-03T12:05:00.000Z",
      source: "xrpc_client",
    });

    expect(aliasStore.listByDid).not.toHaveBeenCalled();
    expect(projectionWorker.onPostUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPost: expect.objectContaining({
          id: "https://example.com/articles/bridge::teaser",
          kind: "note",
          bodyPlaintext: "Updated article teaser",
        }),
        atRecord: {
          collection: "app.bsky.feed.post",
          rkey: "teaser12345ab",
        },
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-article-teaser-update-1",
        }),
      }),
    );
    expect(resultStore.publishResult).not.toHaveBeenCalled();
  });
});
