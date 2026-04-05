import { describe, expect, it, vi } from "vitest";
import { DefaultAtProjectionPolicy } from "../../at-adapter/projection/AtProjectionPolicy.js";
import { DefaultAtProjectionWorker } from "../../at-adapter/projection/AtProjectionWorker.js";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";

describe("native AT video write path", () => {
  it("preserves native app.bsky.embed.video records instead of reserializing them away", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    const identityRepo = {
      getByCanonicalAccountId: vi.fn().mockResolvedValue({
        canonicalAccountId: "acct:alice",
        atprotoDid: "did:plc:alice",
        atprotoHandle: "alice.example.com",
        status: "active",
      }),
    };
    const repoRegistry = {
      getRepoState: vi.fn().mockResolvedValue({
        did: "did:plc:alice",
        rev: "1",
      }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const postSerializer = {
      serialize: vi.fn().mockResolvedValue({
        $type: "app.bsky.feed.post",
        text: "should not be used",
      }),
    };
    const commitBuilder = {
      buildCommit: vi.fn().mockResolvedValue({
        rev: "2",
        commitCid: "bafy-commit-video",
      }),
    };
    const persistenceService = {
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const projectionWorker = new DefaultAtProjectionWorker(
      new DefaultAtProjectionPolicy(),
      identityRepo as any,
      repoRegistry as any,
      {} as any,
      postSerializer as any,
      {} as any,
      {
        postRkey: vi.fn().mockReturnValue("3kvideo-native"),
        profileRkey: vi.fn(),
      } as any,
      aliasStore,
      commitBuilder as any,
      persistenceService as any,
      eventPublisher as any,
      {
        mediaResolver: {} as any,
        facetBuilder: {} as any,
        embedBuilder: {} as any,
        recordRefResolver: {} as any,
        subjectResolver: {} as any,
        targetAliasResolver: {} as any,
        followSerializer: {} as any,
        likeSerializer: {} as any,
        repostSerializer: {} as any,
      },
    );
    const resultStore = {
      publishResult: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DefaultCanonicalClientWriteService({
      projectionWorker,
      aliasStore,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-video-native-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        $type: "app.bsky.feed.post",
        text: "Native video post",
        createdAt: "2026-04-03T12:00:00.000Z",
        embed: {
          $type: "app.bsky.embed.video",
          video: {
            $type: "blob",
            ref: { $link: "bafkrei-native-video" },
            mimeType: "video/mp4",
            size: 4096,
          },
          alt: "A native AT video",
          aspectRatio: {
            width: 1920,
            height: 1080,
          },
        },
        _atRepo: "did:plc:alice",
        _collection: "app.bsky.feed.post",
        _operation: "create",
        _rkey: "3kvideo-native",
      },
      submittedAt: "2026-04-03T12:00:00.000Z",
      source: "xrpc_client",
    });

    expect(postSerializer.serialize).not.toHaveBeenCalled();
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      "at.repo.op.v1",
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        record: expect.objectContaining({
          embed: {
            $type: "app.bsky.embed.video",
            video: {
              $type: "blob",
              ref: { $link: "bafkrei-native-video" },
              mimeType: "video/mp4",
              size: 4096,
            },
            alt: "A native AT video",
            aspectRatio: {
              width: 1920,
              height: 1080,
            },
          },
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-video-native-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/app.bsky.feed.post/3kvideo-native",
      }),
    );
  });
});
