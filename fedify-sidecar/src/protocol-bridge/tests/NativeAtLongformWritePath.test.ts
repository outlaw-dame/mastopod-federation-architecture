import { describe, expect, it, vi } from "vitest";
import { DefaultCanonicalClientWriteService } from "../../at-adapter/writes/DefaultCanonicalClientWriteService.js";
import { DefaultAtCommitPersistenceService } from "../../at-adapter/repo/AtCommitPersistenceService.js";
import { InMemoryAtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";

describe("native AT longform write path", () => {
  it("converts bridged site.standard.document mutations into canonical article events", async () => {
    const projectionWorker = {
      onPostCreated: vi.fn().mockResolvedValue(undefined),
    };
    const aliasStore = {
      getByCanonicalRefId: vi.fn().mockResolvedValue({
        canonicalRefId: "canonical-article-1",
        canonicalType: "article",
        did: "did:plc:alice",
        collection: "site.standard.document",
        rkey: "3karticle",
        atUri: "at://did:plc:alice/site.standard.document/3karticle",
        cid: "bafy-article",
        lastRev: "3",
        createdAt: "2026-04-03T10:00:00.000Z",
        updatedAt: "2026-04-03T10:00:00.000Z",
      }),
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
      clientMutationId: "mutation-1",
      canonicalAccountId: "acct:alice",
      mutationType: "post_create",
      payload: {
        _collection: "site.standard.document",
        _bridgeCanonicalRefId: "canonical-article-1",
        _bridgeMetadata: {
          canonicalIntentId: "intent-article-1",
          sourceProtocol: "activitypub",
          provenance: {
            originProtocol: "activitypub",
            originEventId: "https://example.com/activities/article-1",
            mirroredFromCanonicalIntentId: "intent-article-1",
            projectionMode: "mirrored",
          },
        },
        title: "Bridge article",
        summary: "Summary",
        text: "Article body",
        url: "https://example.com/articles/bridge",
        createdAt: "2026-04-03T12:00:00.000Z",
      },
      submittedAt: "2026-04-03T12:00:00.000Z",
      source: "xrpc_client",
    });

    expect(projectionWorker.onPostCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPost: expect.objectContaining({
          id: "canonical-article-1",
          kind: "article",
          title: "Bridge article",
          summaryPlaintext: "Summary",
          canonicalUrl: "https://example.com/articles/bridge",
        }),
        bridge: expect.objectContaining({
          canonicalIntentId: "intent-article-1",
        }),
      }),
    );
    expect(resultStore.publishResult).toHaveBeenCalledWith(
      "mutation-1",
      expect.objectContaining({
        uri: "at://did:plc:alice/site.standard.document/3karticle",
      }),
    );
  });

  it("emits persisted at.commit.v1 ops with article records and bridge metadata", async () => {
    const aliasStore = new InMemoryAtAliasStore();
    await aliasStore.put({
      canonicalRefId: "canonical-article-1",
      canonicalType: "article",
      did: "did:plc:alice",
      collection: "site.standard.document",
      rkey: "3karticle",
      atUri: "at://did:plc:alice/site.standard.document/3karticle",
      createdAt: "2026-04-03T10:00:00.000Z",
      updatedAt: "2026-04-03T10:00:00.000Z",
    });

    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
    };

    const persistence = new DefaultAtCommitPersistenceService(
      aliasStore,
      eventPublisher as any,
      redis as any,
    );

    await persistence.persist({
      did: "did:plc:alice",
      rev: "4",
      commitCid: "bafy-commit",
      prevCommitCid: "bafy-prev",
      signature: "sig",
      unsignedCommitBytesBase64: "bytes",
      ops: [
        {
          did: "did:plc:alice",
          canonicalAccountId: "acct:alice",
          opId: "op-1",
          opType: "create",
          collection: "site.standard.document",
          rkey: "3karticle",
          canonicalRefId: "canonical-article-1",
          record: {
            $type: "site.standard.document",
            title: "Bridge article",
            text: "Article body",
          },
          bridge: {
            canonicalIntentId: "intent-article-1",
            sourceProtocol: "activitypub",
            provenance: {
              originProtocol: "activitypub",
              originEventId: "https://example.com/activities/article-1",
              mirroredFromCanonicalIntentId: "intent-article-1",
              projectionMode: "mirrored",
            },
          },
          emittedAt: "2026-04-03T12:00:00.000Z",
        },
      ],
    });

    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      "at.commit.v1",
      expect.objectContaining({
        ops: [
          expect.objectContaining({
            collection: "site.standard.document",
            record: expect.objectContaining({
              $type: "site.standard.document",
            }),
            bridge: expect.objectContaining({
              canonicalIntentId: "intent-article-1",
            }),
          }),
        ],
      }),
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      "at.egress.v1",
      expect.objectContaining({
        kind: "article",
      }),
    );
  });
});
