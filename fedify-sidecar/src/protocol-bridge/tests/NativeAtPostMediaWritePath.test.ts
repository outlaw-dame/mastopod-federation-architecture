import { describe, expect, it, vi } from "vitest";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";
import {
  InMemoryBridgePostMediaStore,
  deriveBridgePostMediaId,
} from "../post/BridgePostMedia.js";

describe("native AT post media write path", () => {
  it("registers local post-media descriptors and forwards stable attachment ids into canonical post events", async () => {
    const projectionWorker = {
      onPostCreated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "post-local-1",
        canonicalType: "post",
        did: "did:plc:alice",
        collection: "app.bsky.feed.post",
        rkey: "3klocal-video",
        atUri: "at://did:plc:alice/app.bsky.feed.post/3klocal-video",
        cid: "bafy-local-post",
        lastRev: "5",
        createdAt: "2026-04-03T16:00:00.000Z",
        updatedAt: "2026-04-03T16:00:00.000Z",
      }),
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
    const postMediaStore = new InMemoryBridgePostMediaStore();

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
      postMediaStore,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-post-media-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        $type: "app.bsky.feed.post",
        text: "Native local video post",
        createdAt: "2026-04-03T16:00:00.000Z",
        embed: {
          $type: "app.bsky.embed.video",
          video: {
            $type: "blob",
            ref: { $link: "bafkrei-native-local-video" },
            mimeType: "video/mp4",
            size: 8192,
          },
          alt: "A locally uploaded AT video",
          aspectRatio: {
            width: 1280,
            height: 720,
          },
        },
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _operation: "create",
        _rkey: "3klocal-video",
        _bridgeCanonicalRefId: "post-local-1",
      },
      submittedAt: "2026-04-03T16:00:00.000Z",
      source: "xrpc_client",
    });

    const mediaId = deriveBridgePostMediaId(
      "post-local-1",
      "video",
      "bafkrei-native-local-video",
      0,
    );

    await expect(postMediaStore.get(mediaId)).resolves.toEqual(
      expect.objectContaining({
        mediaId,
        canonicalPostId: "post-local-1",
        ownerDid: "did:plc:alice",
        kind: "video",
        blob: expect.objectContaining({
          ref: { $link: "bafkrei-native-local-video" },
          mimeType: "video/mp4",
        }),
        alt: "A locally uploaded AT video",
        width: 1280,
        height: 720,
      }),
    );

    expect(projectionWorker.onPostCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPost: expect.objectContaining({
          id: "post-local-1",
          attachments: [
            {
              kind: "video",
              mediaId,
              altText: "A locally uploaded AT video",
              width: 1280,
              height: 720,
            },
          ],
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-post-media-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/app.bsky.feed.post/3klocal-video",
      }),
    );
  });

  it("prunes stale local post-media descriptors on native updates", async () => {
    const projectionWorker = {
      onPostUpdated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "post-local-1",
        canonicalType: "post",
        did: "did:plc:alice",
        collection: "app.bsky.feed.post",
        rkey: "3klocal-video",
        atUri: "at://did:plc:alice/app.bsky.feed.post/3klocal-video",
        cid: "bafy-local-post",
        lastRev: "6",
        createdAt: "2026-04-03T16:00:00.000Z",
        updatedAt: "2026-04-03T16:00:00.000Z",
      }),
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
    const postMediaStore = new InMemoryBridgePostMediaStore();
    const staleMediaId = deriveBridgePostMediaId(
      "post-local-1",
      "video",
      "bafkrei-stale-video",
      0,
    );
    await postMediaStore.put({
      mediaId: staleMediaId,
      canonicalPostId: "post-local-1",
      ownerDid: "did:plc:alice",
      kind: "video",
      blob: {
        $type: "blob",
        ref: { $link: "bafkrei-stale-video" },
        mimeType: "video/mp4",
        size: 4096,
      },
      alt: "stale video",
      width: 1280,
      height: 720,
      createdAt: "2026-04-03T16:00:00.000Z",
    });

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
      postMediaStore,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-post-media-update-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        $type: "app.bsky.feed.post",
        text: "Native local image post",
        createdAt: "2026-04-03T16:05:00.000Z",
        embed: {
          $type: "app.bsky.embed.images",
          images: [
            {
              image: {
                $type: "blob",
                ref: { $link: "bafkrei-fresh-image" },
                mimeType: "image/jpeg",
                size: 2048,
              },
              alt: "A fresh image",
              aspectRatio: {
                width: 1200,
                height: 630,
              },
            },
          ],
        },
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _operation: "update",
        _rkey: "3klocal-video",
        _bridgeCanonicalRefId: "post-local-1",
      },
      submittedAt: "2026-04-03T16:05:00.000Z",
      source: "xrpc_client",
    });

    const freshMediaId = deriveBridgePostMediaId(
      "post-local-1",
      "image",
      "bafkrei-fresh-image",
      0,
    );

    await expect(postMediaStore.get(staleMediaId)).resolves.toBeNull();
    await expect(postMediaStore.get(freshMediaId)).resolves.toEqual(
      expect.objectContaining({
        mediaId: freshMediaId,
        kind: "image",
        ownerDid: "did:plc:alice",
      }),
    );
    await expect(postMediaStore.listByCanonicalPostId("post-local-1")).resolves.toEqual([
      expect.objectContaining({
        mediaId: freshMediaId,
        canonicalPostId: "post-local-1",
      }),
    ]);
    expect(projectionWorker.onPostUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPost: expect.objectContaining({
          attachments: [
            expect.objectContaining({
              kind: "image",
              mediaId: freshMediaId,
            }),
          ],
        }),
      }),
    );
  });

  it("deletes stored local post-media descriptors after native post deletes", async () => {
    const projectionWorker = {
      onPostDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue(null),
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
    const postMediaStore = new InMemoryBridgePostMediaStore();
    const mediaId = deriveBridgePostMediaId(
      "post-local-1",
      "video",
      "bafkrei-local-delete-video",
      0,
    );
    await postMediaStore.put({
      mediaId,
      canonicalPostId: "post-local-1",
      ownerDid: "did:plc:alice",
      kind: "video",
      blob: {
        $type: "blob",
        ref: { $link: "bafkrei-local-delete-video" },
        mimeType: "video/mp4",
        size: 4096,
      },
      alt: "delete me",
      width: 1280,
      height: 720,
      createdAt: "2026-04-03T16:00:00.000Z",
    });

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: {
        ...aliasStore,
        listByDid: vi.fn().mockResolvedValue([
          {
            canonicalRefId: "post-local-1",
            canonicalType: "post",
            did: "did:plc:alice",
            collection: "app.bsky.feed.post",
            rkey: "3klocal-video",
            atUri: "at://did:plc:alice/app.bsky.feed.post/3klocal-video",
            createdAt: "2026-04-03T16:00:00.000Z",
            updatedAt: "2026-04-03T16:00:00.000Z",
          },
        ]),
      } as any,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
      postMediaStore,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-post-media-delete-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_delete",
      payload: {
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _rkey: "3klocal-video",
      },
      submittedAt: "2026-04-03T16:10:00.000Z",
      source: "xrpc_client",
    });

    await expect(postMediaStore.get(mediaId)).resolves.toBeNull();
    await expect(postMediaStore.listByCanonicalPostId("post-local-1")).resolves.toEqual([]);
    expect(projectionWorker.onPostDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPostId: "post-local-1",
      }),
    );
  });
});
