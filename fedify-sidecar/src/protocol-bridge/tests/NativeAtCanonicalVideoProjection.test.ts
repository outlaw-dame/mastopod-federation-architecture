import { describe, expect, it, vi } from "vitest";
import { DefaultAtBlobStore } from "../../at-adapter/blob/AtBlobStore.js";
import { DefaultBlobReferenceMapper } from "../../at-adapter/blob/BlobReferenceMapper.js";
import { DefaultAtBlobUploadService } from "../../at-adapter/blob/AtBlobUploadService.js";
import { DefaultAtProjectionPolicy } from "../../at-adapter/projection/AtProjectionPolicy.js";
import { DefaultAtProjectionWorker } from "../../at-adapter/projection/AtProjectionWorker.js";
import { DefaultEmbedBuilder } from "../../at-adapter/projection/serializers/EmbedBuilder.js";
import { DefaultImageEmbedBuilder } from "../../at-adapter/projection/serializers/ImageEmbedBuilder.js";
import { DefaultPostRecordSerializer } from "../../at-adapter/projection/serializers/PostRecordSerializer.js";
import { StoredAttachmentMediaResolver } from "../../at-adapter/projection/serializers/StoredAttachmentMediaResolver.js";
import { DefaultVideoEmbedBuilder } from "../../at-adapter/projection/serializers/VideoEmbedBuilder.js";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { InMemoryBridgePostMediaStore } from "../post/BridgePostMedia.js";

describe("native canonical AT video projection", () => {
  it("serializes canonical video attachments into app.bsky.embed.video and prefers video over images", async () => {
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
      register: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const commitBuilder = {
      buildCommit: vi.fn().mockResolvedValue({
        rev: "2",
        commitCid: "bafy-commit-canonical-video",
      }),
    };
    const persistenceService = {
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const postMediaStore = new InMemoryBridgePostMediaStore();
    await postMediaStore.put({
      mediaId: "video-1",
      canonicalPostId: "post-video-1",
      ownerDid: "did:plc:alice",
      kind: "video",
      blob: {
        $type: "blob",
        ref: { $link: "bafkrei-stored-video-1" },
        mimeType: "video/mp4",
        size: 4096,
      },
      alt: "Canonical video alt",
      width: 1920,
      height: 1080,
      createdAt: "2026-04-03T15:00:00.000Z",
    });
    await postMediaStore.put({
      mediaId: "image-1",
      canonicalPostId: "post-video-1",
      ownerDid: "did:plc:alice",
      kind: "image",
      blob: {
        $type: "blob",
        ref: { $link: "bafkrei-stored-image-1" },
        mimeType: "image/jpeg",
        size: 1024,
      },
      alt: "Should be ignored because video wins",
      width: 640,
      height: 360,
      createdAt: "2026-04-03T15:00:00.000Z",
    });
    const blobStore = new DefaultAtBlobStore();
    const blobMapper = new DefaultBlobReferenceMapper();
    const blobUploadService = new DefaultAtBlobUploadService(blobStore, blobMapper);
    const ensureBlobSpy = vi.spyOn(blobUploadService, "ensureBlob");
    const ensureImageBlobSpy = vi.spyOn(blobUploadService, "ensureImageBlob");
    const mediaResolver = new StoredAttachmentMediaResolver(postMediaStore);
    const embedBuilder = new DefaultEmbedBuilder(
      new DefaultImageEmbedBuilder(blobUploadService, mediaResolver),
      new DefaultVideoEmbedBuilder(blobUploadService, mediaResolver),
    );

    const worker = new DefaultAtProjectionWorker(
      new DefaultAtProjectionPolicy(),
      identityRepo as any,
      repoRegistry as any,
      {} as any,
      new DefaultPostRecordSerializer(),
      {} as any,
      {
        postRkey: vi.fn().mockReturnValue("3kcanonical-video"),
        profileRkey: vi.fn(),
      } as any,
      aliasStore,
      commitBuilder as any,
      persistenceService as any,
      eventPublisher as any,
      {
        mediaResolver: {
          resolveAvatarBlob: async () => null,
          resolveBannerBlob: async () => null,
        },
        facetBuilder: {
          build: async () => [],
        },
        embedBuilder,
        recordRefResolver: {} as any,
        subjectResolver: {} as any,
        targetAliasResolver: {} as any,
        followSerializer: {} as any,
        likeSerializer: {} as any,
        repostSerializer: {} as any,
      },
    );

    await worker.onPostCreated({
      canonicalPost: {
        id: "post-video-1",
        authorId: "acct:alice",
        bodyPlaintext: "Native canonical video post",
        visibility: "public",
        publishedAt: "2026-04-03T15:00:00.000Z",
        attachments: [
          {
            kind: "image",
            mediaId: "image-1",
            altText: "Should be ignored because video wins",
            width: 640,
            height: 360,
          },
          {
            kind: "video",
            mediaId: "video-1",
            altText: "Canonical video alt",
            width: 1920,
            height: 1080,
          },
        ],
      },
      author: { id: "acct:alice" } as any,
      emittedAt: "2026-04-03T15:00:00.000Z",
    });

    expect(ensureBlobSpy).not.toHaveBeenCalled();
    expect(ensureImageBlobSpy).not.toHaveBeenCalled();
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      "at.repo.op.v1",
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        rkey: "3kcanonical-video",
        record: expect.objectContaining({
          $type: "app.bsky.feed.post",
          text: "Native canonical video post",
          embed: expect.objectContaining({
            $type: "app.bsky.embed.video",
            alt: "Canonical video alt",
            aspectRatio: {
              width: 1920,
              height: 1080,
            },
            video: expect.objectContaining({
              $type: "blob",
              ref: { $link: "bafkrei-stored-video-1" },
              mimeType: "video/mp4",
              size: 4096,
            }),
          }),
        }),
      }),
    );
  });
});
