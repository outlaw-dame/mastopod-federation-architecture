import { describe, expect, it, vi } from "vitest";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";

describe("native AT social bridge write path", () => {
  it("preserves bridge metadata and canonical ref hints for bridged likes", async () => {
    const projectionWorker = {
      onLikeCreated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "canonical-like-1",
        atUri: "at://did:plc:alice/app.bsky.feed.like/3klike",
        cid: "bafy-like",
        lastRev: "2",
      }),
      listByDid: vi.fn().mockResolvedValue([]),
    };
    const resultStore = {
      publishResult: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: {} as any,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-like-1",
      canonicalAccountId: "acct:alice",
      mutationType: "like_create",
      payload: {
        _bridgeCanonicalRefId: "canonical-like-1",
        _bridgeMetadata: {
          canonicalIntentId: "intent-like-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/like-1",
            mirroredFromCanonicalIntentId: "intent-like-1",
            projectionMode: "mirrored",
          },
        },
        subject: {
          uri: "at://did:plc:bob/app.bsky.feed.post/3kpost",
          cid: "bafy-post-1",
        },
      },
      submittedAt: "2026-04-03T12:00:00.000Z",
      source: "xrpc_client",
    });

    expect(projectionWorker.onLikeCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        like: expect.objectContaining({
          id: "canonical-like-1",
        }),
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-like-1",
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-like-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/app.bsky.feed.like/3klike",
      }),
    );
  });
});
