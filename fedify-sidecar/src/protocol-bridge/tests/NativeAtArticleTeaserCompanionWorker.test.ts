import { describe, expect, it, vi } from "vitest";
import { DefaultAtProjectionPolicy } from "../../at-adapter/projection/AtProjectionPolicy.js";
import { DefaultAtProjectionWorker } from "../../at-adapter/projection/AtProjectionWorker.js";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";

describe("native AT article teaser companion worker", () => {
  it("creates a teaser post companion for local article creates in the same commit", async () => {
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
    const commitBuilder = {
      buildCommit: vi.fn().mockResolvedValue({
        rev: "2",
        commitCid: "bafy-article-teaser-create",
      }),
    };
    const persistenceService = {
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new DefaultAtProjectionWorker(
      new DefaultAtProjectionPolicy(),
      identityRepo as any,
      repoRegistry as any,
      {} as any,
      {} as any,
      {
        serialize: vi.fn().mockResolvedValue({
          $type: "site.standard.document",
          title: "Local article",
          summary: "Native article summary",
          text: "Native article body",
          publishedAt: "2026-04-03T17:00:00.000Z",
          url: "https://example.com/articles/local",
        }),
      } as any,
      {
        postRkey: vi.fn().mockReturnValue("3karticlelocal"),
        profileRkey: vi.fn(),
      } as any,
      aliasStore,
      commitBuilder as any,
      persistenceService as any,
      eventPublisher as any,
      {
        mediaResolver: {} as any,
        facetBuilder: {} as any,
        embedBuilder: {
          build: vi.fn().mockResolvedValue(undefined),
        } as any,
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
        id: "local-article-1",
        authorId: "acct:alice",
        kind: "article",
        title: "Local article",
        summaryPlaintext: "Native article summary",
        bodyPlaintext: "Native article body",
        canonicalUrl: "https://example.com/articles/local",
        visibility: "public",
        publishedAt: "2026-04-03T17:00:00.000Z",
      },
      author: { id: "acct:alice" } as any,
      generateTeaserCompanion: true,
      emittedAt: "2026-04-03T17:00:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          collection: "site.standard.document",
          canonicalRefId: "local-article-1",
        }),
        expect.objectContaining({
          collection: "app.bsky.feed.post",
          canonicalRefId: "local-article-1::teaser",
          record: expect.objectContaining({
            $type: "app.bsky.feed.post",
            embed: {
              $type: "app.bsky.embed.external",
              external: {
                uri: "https://example.com/articles/local",
                title: "Local article",
                description: "Native article summary",
              },
            },
          }),
        }),
      ]),
    );
    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    await expect(aliasStore.getByCanonicalRefId("local-article-1::teaser")).resolves.toEqual(
      expect.objectContaining({
        collection: "app.bsky.feed.post",
        canonicalUrl: expect.stringContaining("/post/"),
      }),
    );
  });

  it("updates and deletes the local teaser companion alongside the article record", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "local-article-1",
      canonicalType: "article",
      did: "did:plc:alice",
      collection: "site.standard.document",
      rkey: "3karticlelocal",
      atUri: "at://did:plc:alice/site.standard.document/3karticlelocal",
      canonicalUrl: "https://example.com/articles/local",
      createdAt: "2026-04-03T17:00:00.000Z",
      updatedAt: "2026-04-03T17:00:00.000Z",
    });
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
        rev: "2",
      }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const commitBuilder = {
      buildCommit: vi.fn().mockResolvedValue({
        rev: "3",
        commitCid: "bafy-article-teaser-update",
      }),
    };
    const persistenceService = {
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new DefaultAtProjectionWorker(
      new DefaultAtProjectionPolicy(),
      identityRepo as any,
      repoRegistry as any,
      {} as any,
      {} as any,
      {
        serialize: vi.fn().mockResolvedValue({
          $type: "site.standard.document",
          title: "Local article updated",
          summary: "Updated summary",
          text: "Updated body",
          publishedAt: "2026-04-03T18:00:00.000Z",
          url: "https://example.com/articles/local",
        }),
      } as any,
      {
        postRkey: vi.fn(),
        profileRkey: vi.fn(),
      } as any,
      aliasStore,
      commitBuilder as any,
      persistenceService as any,
      eventPublisher as any,
      {
        mediaResolver: {} as any,
        facetBuilder: {} as any,
        embedBuilder: {
          build: vi.fn().mockResolvedValue(undefined),
        } as any,
        recordRefResolver: {} as any,
        subjectResolver: {} as any,
        targetAliasResolver: {} as any,
        followSerializer: {} as any,
        likeSerializer: {} as any,
        repostSerializer: {} as any,
      },
    );

    await worker.onPostUpdated({
      canonicalPost: {
        id: "local-article-1",
        authorId: "acct:alice",
        kind: "article",
        title: "Local article updated",
        summaryPlaintext: "Updated summary",
        bodyPlaintext: "Updated body",
        canonicalUrl: "https://example.com/articles/local",
        visibility: "public",
        publishedAt: "2026-04-03T18:00:00.000Z",
      },
      author: { id: "acct:alice" } as any,
      generateTeaserCompanion: true,
      emittedAt: "2026-04-03T18:00:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          collection: "site.standard.document",
          opType: "update",
        }),
        expect.objectContaining({
          collection: "app.bsky.feed.post",
          canonicalRefId: "local-article-1::teaser",
          opType: "update",
        }),
      ]),
    );

    await worker.onPostDeleted({
      canonicalPostId: "local-article-1",
      canonicalAuthorId: "acct:alice",
      atRecord: {
        collection: "site.standard.document",
        rkey: "3karticlelocal",
      },
      generateTeaserCompanion: true,
      deletedAt: "2026-04-03T18:30:00.000Z",
      emittedAt: "2026-04-03T18:30:00.000Z",
    });

    expect(commitBuilder.buildCommit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          collection: "site.standard.document",
          opType: "delete",
        }),
        expect.objectContaining({
          collection: "app.bsky.feed.post",
          canonicalRefId: "local-article-1::teaser",
          opType: "delete",
        }),
      ]),
    );

    await expect(aliasStore.getByCanonicalRefId("local-article-1")).resolves.toEqual(
      expect.objectContaining({
        deletedAt: "2026-04-03T18:30:00.000Z",
      }),
    );
    await expect(aliasStore.getByCanonicalRefId("local-article-1::teaser")).resolves.toEqual(
      expect.objectContaining({
        deletedAt: "2026-04-03T18:30:00.000Z",
      }),
    );
  });
});
