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

  it("preserves custom emoji reaction metadata for bridged ActivityPods emoji reactions", async () => {
    const projectionWorker = {
      onEmojiReactionCreated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "canonical-emoji-reaction-1",
        atUri: "at://did:plc:alice/org.activitypods.emojiReaction/3kemoji",
        cid: "bafy-emoji",
        lastRev: "3",
      }),
      listByDid: vi.fn().mockResolvedValue([
        {
          canonicalRefId: "canonical-post-1",
          collection: "app.bsky.feed.post",
          rkey: "3kpost",
          atUri: "at://did:plc:bob/app.bsky.feed.post/3kpost",
          cid: "bafy-post-1",
          deletedAt: null,
        },
      ]),
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
      clientMutationId: "mutation-emoji-1",
      canonicalAccountId: "acct:alice",
      mutationType: "emoji_reaction_create",
      payload: {
        _bridgeCanonicalRefId: "canonical-emoji-reaction-1",
        _bridgeMetadata: {
          canonicalIntentId: "intent-emoji-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/emoji-react-1",
            mirroredFromCanonicalIntentId: "intent-emoji-1",
            projectionMode: "mirrored",
          },
        },
        $type: "org.activitypods.emojiReaction",
        subject: {
          uri: "at://did:plc:bob/app.bsky.feed.post/3kpost",
          cid: "bafy-post-1",
        },
        reaction: ":blobcat:",
        emoji: {
          shortcode: ":blobcat:",
          emojiId: "https://emoji.example/blobcat",
          icon: {
            uri: "https://emoji.example/blobcat.png",
            mediaType: "image/png",
          },
          domain: "emoji.example",
        },
        createdAt: "2026-04-18T12:00:00.000Z",
      },
      submittedAt: "2026-04-18T12:00:00.000Z",
      source: "xrpc_client",
    });

    expect(projectionWorker.onEmojiReactionCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        reaction: expect.objectContaining({
          id: "canonical-emoji-reaction-1",
          postId: "canonical-post-1",
          content: ":blobcat:",
          emoji: expect.objectContaining({
            shortcode: ":blobcat:",
            iconUrl: "https://emoji.example/blobcat.png",
          }),
        }),
        nativeRecord: expect.objectContaining({
          $type: "org.activitypods.emojiReaction",
          reaction: ":blobcat:",
        }),
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-emoji-1",
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-emoji-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/org.activitypods.emojiReaction/3kemoji",
      }),
    );
  });
});
