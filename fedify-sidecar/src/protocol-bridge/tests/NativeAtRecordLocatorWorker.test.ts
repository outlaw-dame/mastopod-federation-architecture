import { describe, expect, it, vi } from "vitest";
import { DefaultAtProjectionWorker } from "../../at-adapter/projection/AtProjectionWorker.js";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";

function createWorkerHarness() {
  const aliasStore = new InMemoryAtAliasStore();
  const commitBuilder = {
    buildCommit: vi.fn(async (_repoState: unknown, ops: unknown[]) => ({
      did: "did:plc:alice",
      rev: "2",
      commitCid: "bafy-commit",
      prevCommitCid: null,
      ops,
    })),
  };
  const persistenceService = {
    persist: vi.fn().mockResolvedValue(undefined),
  };
  const eventPublisher = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const repoRegistry = {
    getRepoState: vi.fn().mockResolvedValue({
      did: "did:plc:alice",
      rev: "1",
      rootCid: "bafy-root",
      collections: [],
      status: "active",
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    }),
    register: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const identityRepo = {
    getByCanonicalAccountId: vi.fn().mockResolvedValue({
      canonicalAccountId: "acct:alice",
      atprotoDid: "did:plc:alice",
      atprotoHandle: "alice.example.com",
      status: "active",
    }),
  };
  const policy = {
    canProjectProfile: vi.fn().mockReturnValue({ allowed: true }),
    canProjectPost: vi.fn().mockReturnValue({ allowed: true }),
    canProjectSocialAction: vi.fn().mockReturnValue({ allowed: true }),
  };
  const profileSerializer = {
    serialize: vi.fn(),
  };
  const postSerializer = {
    serialize: vi.fn().mockResolvedValue({
      $type: "app.bsky.feed.post",
      text: "hello bridge",
    }),
  };
  const standardDocumentSerializer = {
    serialize: vi.fn().mockResolvedValue({
      $type: "site.standard.document",
      text: "article body",
    }),
  };
  const rkeyService = {
    profileRkey: vi.fn().mockReturnValue("self"),
    postRkey: vi.fn().mockReturnValue("generated-rkey"),
  };
  const worker = new DefaultAtProjectionWorker(
    policy as any,
    identityRepo as any,
    repoRegistry as any,
    profileSerializer as any,
    postSerializer as any,
    standardDocumentSerializer as any,
    rkeyService as any,
    aliasStore,
    commitBuilder as any,
    persistenceService as any,
    eventPublisher as any,
    {
      mediaResolver: {} as any,
      facetBuilder: {} as any,
      embedBuilder: {} as any,
      recordRefResolver: {} as any,
      subjectResolver: {
        resolveDidForIdentity: vi.fn().mockResolvedValue("did:plc:bob"),
      },
      targetAliasResolver: {
        resolvePostStrongRef: vi.fn().mockResolvedValue({
          uri: "at://did:plc:bob/app.bsky.feed.post/3kpost",
          cid: "bafy-target-post",
        }),
      },
      followSerializer: {
        serialize: vi.fn().mockReturnValue({ $type: "app.bsky.graph.follow" }),
      },
      likeSerializer: {
        serialize: vi.fn().mockReturnValue({ $type: "app.bsky.feed.like" }),
      },
      repostSerializer: {
        serialize: vi.fn().mockReturnValue({ $type: "app.bsky.feed.repost" }),
      },
    } as any,
  );

  return {
    worker,
    aliasStore,
    commitBuilder,
    persistenceService,
    rkeyService,
  };
}

describe("native AT record locator worker behavior", () => {
  it("honors explicit AT record locators for bridged post creates", async () => {
    const { worker, aliasStore, commitBuilder, rkeyService } = createWorkerHarness();

    await worker.onPostCreated({
      canonicalPost: {
        id: "canonical-post-1",
        authorId: "acct:alice",
        kind: "note",
        bodyPlaintext: "hello bridge",
        visibility: "public",
        publishedAt: "2026-04-03T12:00:00.000Z",
      },
      author: { id: "acct:alice" },
      atRecord: {
        collection: "app.bsky.feed.post",
        rkey: "fixedpost12345",
      },
      emittedAt: "2026-04-03T12:00:00.000Z",
    });

    expect(rkeyService.postRkey).not.toHaveBeenCalled();
    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          collection: "app.bsky.feed.post",
          rkey: "fixedpost12345",
          canonicalRefId: "canonical-post-1",
        }),
      ],
    );
    const alias = await aliasStore.getByCanonicalRefId("canonical-post-1");
    expect(alias?.rkey).toBe("fixedpost12345");
    expect(alias?.canonicalUrl).toBe("https://bsky.app/profile/did:plc:alice/post/fixedpost12345");
  });

  it("stores the canonical article URL on the native AT alias for later AP parity", async () => {
    const { worker, aliasStore } = createWorkerHarness();

    await worker.onPostCreated({
      canonicalPost: {
        id: "canonical-article-1",
        authorId: "acct:alice",
        kind: "article",
        title: "Bridge article",
        bodyPlaintext: "article body",
        canonicalUrl: "https://example.com/articles/bridge",
        visibility: "public",
        publishedAt: "2026-04-03T12:00:00.000Z",
      },
      author: { id: "acct:alice" },
      atRecord: {
        collection: "site.standard.document",
        rkey: "fixedarticle12",
      },
      emittedAt: "2026-04-03T12:00:00.000Z",
    });

    const alias = await aliasStore.getByCanonicalRefId("canonical-article-1");
    expect(alias).toEqual(
      expect.objectContaining({
        collection: "site.standard.document",
        rkey: "fixedarticle12",
        canonicalUrl: "https://example.com/articles/bridge",
      }),
    );
  });

  it("rehydrates a placeholder alias from an explicit AT locator for bridged updates", async () => {
    const { worker, aliasStore, commitBuilder } = createWorkerHarness();

    await worker.onPostUpdated({
      canonicalPost: {
        id: "canonical-post-1",
        authorId: "acct:alice",
        kind: "note",
        bodyPlaintext: "updated bridge body",
        visibility: "public",
        publishedAt: "2026-04-03T12:05:00.000Z",
      },
      author: { id: "acct:alice" },
      atRecord: {
        collection: "app.bsky.feed.post",
        rkey: "fixedpost12345",
      },
      emittedAt: "2026-04-03T12:05:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          collection: "app.bsky.feed.post",
          rkey: "fixedpost12345",
          canonicalRefId: "canonical-post-1",
          opType: "update",
        }),
      ],
    );
    const alias = await aliasStore.getByCanonicalRefId("canonical-post-1");
    expect(alias).toEqual(
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        rkey: "fixedpost12345",
        canonicalUrl: "https://bsky.app/profile/did:plc:alice/post/fixedpost12345",
        deletedAt: null,
      }),
    );
  });

  it("refreshes the stored canonical article URL on native AT article updates", async () => {
    const { worker, aliasStore, commitBuilder } = createWorkerHarness();
    await aliasStore.put({
      canonicalRefId: "canonical-article-1",
      canonicalType: "article",
      did: "did:plc:alice",
      collection: "site.standard.document",
      rkey: "fixedarticle12",
      atUri: "at://did:plc:alice/site.standard.document/fixedarticle12",
      canonicalUrl: "https://example.com/articles/old",
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    });

    await worker.onPostUpdated({
      canonicalPost: {
        id: "canonical-article-1",
        authorId: "acct:alice",
        kind: "article",
        title: "Bridge article",
        bodyPlaintext: "updated article body",
        canonicalUrl: "https://example.com/articles/new",
        visibility: "public",
        publishedAt: "2026-04-03T12:05:00.000Z",
      },
      author: { id: "acct:alice" },
      atRecord: {
        collection: "site.standard.document",
        rkey: "fixedarticle12",
      },
      emittedAt: "2026-04-03T12:05:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          collection: "site.standard.document",
          rkey: "fixedarticle12",
          canonicalRefId: "canonical-article-1",
          opType: "update",
        }),
      ],
    );
    const alias = await aliasStore.getByCanonicalRefId("canonical-article-1");
    expect(alias?.canonicalUrl).toBe("https://example.com/articles/new");
  });

  it("rehydrates a placeholder teaser alias from an explicit AT locator for bridged article teaser upserts", async () => {
    const { worker, aliasStore, commitBuilder } = createWorkerHarness();

    await worker.onPostUpdated({
      canonicalPost: {
        id: "canonical-article-1::teaser",
        authorId: "acct:alice",
        kind: "note",
        bodyPlaintext: "Updated teaser body",
        visibility: "public",
        publishedAt: "2026-04-03T12:07:00.000Z",
      },
      author: { id: "acct:alice" },
      atRecord: {
        collection: "app.bsky.feed.post",
        rkey: "teaser12345ab",
      },
      emittedAt: "2026-04-03T12:07:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          collection: "app.bsky.feed.post",
          rkey: "teaser12345ab",
          canonicalRefId: "canonical-article-1::teaser",
          opType: "update",
        }),
      ],
    );
    const alias = await aliasStore.getByCanonicalRefId("canonical-article-1::teaser");
    expect(alias).toEqual(
      expect.objectContaining({
        canonicalType: "post",
        collection: "app.bsky.feed.post",
        rkey: "teaser12345ab",
        canonicalUrl: "https://bsky.app/profile/did:plc:alice/post/teaser12345ab",
        deletedAt: null,
      }),
    );
  });

  it("uses explicit AT locators for bridged social deletes when alias state is missing", async () => {
    const { worker, aliasStore, commitBuilder } = createWorkerHarness();

    await worker.onLikeDeleted({
      canonicalLikeId: "canonical-like-1",
      canonicalActorId: "acct:alice",
      canonicalPostId: "",
      atRecord: {
        collection: "app.bsky.feed.like",
        rkey: "fixedlike12345",
      },
      bridge: {
        canonicalIntentId: "intent-like-delete-1",
        sourceProtocol: "activitypub",
        provenance: {
          originProtocol: "activitypub",
          originEventId: "https://example.com/activities/undo-like-1",
          mirroredFromCanonicalIntentId: "intent-like-delete-1",
          projectionMode: "mirrored",
        },
      },
      deletedAt: "2026-04-03T12:10:00.000Z",
      emittedAt: "2026-04-03T12:10:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          collection: "app.bsky.feed.like",
          rkey: "fixedlike12345",
          canonicalRefId: "canonical-like-1",
          opType: "delete",
          bridge: expect.objectContaining({
            canonicalIntentId: "intent-like-delete-1",
          }),
        }),
      ],
    );
    const alias = await aliasStore.getByCanonicalRefId("canonical-like-1");
    expect(alias).toEqual(
      expect.objectContaining({
        collection: "app.bsky.feed.like",
        rkey: "fixedlike12345",
        deletedAt: "2026-04-03T12:10:00.000Z",
      }),
    );
  });

  it("uses explicit AT locators for bridged emoji reaction deletes when alias state is missing", async () => {
    const { worker, aliasStore, commitBuilder } = createWorkerHarness();

    await worker.onEmojiReactionDeleted({
      canonicalReactionId: "canonical-emoji-reaction-1",
      canonicalActorId: "acct:alice",
      canonicalPostId: "",
      atRecord: {
        collection: "org.activitypods.emojiReaction",
        rkey: "fixedemoji1234",
      },
      bridge: {
        canonicalIntentId: "intent-emoji-delete-1",
        sourceProtocol: "activitypub",
        provenance: {
          originProtocol: "activitypub",
          originEventId: "https://example.com/activities/undo-emoji-react-1",
          mirroredFromCanonicalIntentId: "intent-emoji-delete-1",
          projectionMode: "mirrored",
        },
      },
      deletedAt: "2026-04-03T12:11:00.000Z",
      emittedAt: "2026-04-03T12:11:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          collection: "org.activitypods.emojiReaction",
          rkey: "fixedemoji1234",
          canonicalRefId: "canonical-emoji-reaction-1",
          opType: "delete",
          bridge: expect.objectContaining({
            canonicalIntentId: "intent-emoji-delete-1",
          }),
        }),
      ],
    );
    const alias = await aliasStore.getByCanonicalRefId("canonical-emoji-reaction-1");
    expect(alias).toEqual(
      expect.objectContaining({
        collection: "org.activitypods.emojiReaction",
        rkey: "fixedemoji1234",
        deletedAt: "2026-04-03T12:11:00.000Z",
      }),
    );
  });
});
