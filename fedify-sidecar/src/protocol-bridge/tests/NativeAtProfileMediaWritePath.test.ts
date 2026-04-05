import { describe, expect, it, vi } from "vitest";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";
import { InMemoryBridgeProfileMediaStore } from "../profile/BridgeProfileMedia.js";

describe("native AT profile media write path", () => {
  it("registers bridged profile media descriptors and forwards stable media ids into canonical profile events", async () => {
    const projectionWorker = {
      onProfileUpserted: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "acct:alice",
        canonicalType: "profile",
        did: "did:plc:alice",
        collection: "app.bsky.actor.profile",
        rkey: "self",
        atUri: "at://did:plc:alice/app.bsky.actor.profile/self",
        cid: "bafy-profile",
        lastRev: "5",
        createdAt: "2026-04-03T12:00:00.000Z",
        updatedAt: "2026-04-03T12:00:00.000Z",
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
    const profileMediaStore = new InMemoryBridgeProfileMediaStore();

    const service = new DefaultCanonicalClientWriteService({
      projectionWorker: projectionWorker as any,
      aliasStore: aliasStore as any,
      resultStore: resultStore as any,
      identityRepo: identityRepo as any,
      profileMediaStore,
    });

    await service.applyClientMutation({
      clientMutationId: "mutation-profile-1",
      canonicalAccountId: "acct:alice",
      mutationType: "profile_upsert",
      payload: {
        _collection: "app.bsky.actor.profile",
        displayName: "Alice Example",
        description: "Bridge bio",
        avatar: {
          $type: "blob",
          ref: { $link: "bafy-native-avatar" },
          mimeType: "image/png",
          size: 1234,
        },
        _bridgeProfileMedia: {
          avatar: {
            mediaId: "avatar-media-1",
            role: "avatar",
            sourceUrl: "https://cdn.example.com/avatar.png",
            mimeType: "image/png",
          },
          banner: {
            mediaId: "banner-media-1",
            role: "banner",
            sourceUrl: "https://cdn.example.com/banner.jpg",
            mimeType: "image/jpeg",
          },
        },
      },
      submittedAt: "2026-04-03T12:00:00.000Z",
      source: "xrpc_client",
    });

    await expect(profileMediaStore.get("avatar-media-1")).resolves.toEqual(
      expect.objectContaining({
        mediaId: "avatar-media-1",
        ownerDid: "did:plc:alice",
        role: "avatar",
        sourceUrl: "https://cdn.example.com/avatar.png",
      }),
    );
    await expect(profileMediaStore.get("banner-media-1")).resolves.toEqual(
      expect.objectContaining({
        mediaId: "banner-media-1",
        ownerDid: "did:plc:alice",
        role: "banner",
        sourceUrl: "https://cdn.example.com/banner.jpg",
      }),
    );

    expect(projectionWorker.onProfileUpserted).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          id: "acct:alice",
          avatarBlobRef: expect.objectContaining({
            ref: { $link: "bafy-native-avatar" },
          }),
          avatarMediaId: "avatar-media-1",
          bannerMediaId: "banner-media-1",
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-profile-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/app.bsky.actor.profile/self",
      }),
    );
  });
});
