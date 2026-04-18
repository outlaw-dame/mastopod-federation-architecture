import { describe, expect, it, vi } from "vitest";
import { OpenSearchFeedProvider } from "../OpenSearchFeedProvider.js";
import type { FeedCandidateService } from "../../search/queries/FeedCandidateService.js";
import type { FeedDefinition } from "../contracts.js";

const definition: FeedDefinition = {
  id: "urn:activitypods:feed:public-discovery:v1",
  kind: "discovery",
  visibility: "public",
  sourcePolicy: {
    includeStream1: false,
    includeStream2: true,
    includeCanonical: true,
    includeFirehose: false,
    includeUnified: false,
  },
  rankingPolicy: { mode: "ranked" },
  hydrationShape: "card",
  realtimeCapable: true,
  supportsSse: true,
  supportsWebSocket: true,
  experimental: false,
  providerId: "opensearch.candidates.v1",
};

describe("OpenSearchFeedProvider", () => {
  it("returns safe skeletons and omits invalid records", async () => {
    const candidateService: FeedCandidateService = {
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [
          { stableDocId: "doc-1", score: 1.2, bucket: "trending" },
          { stableDocId: "doc-2", score: 0.9, bucket: "interest" },
        ],
      }),
    };

    const osClient = {
      search: vi.fn().mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _id: "doc-1",
                _source: {
                  stableDocId: "doc-1",
                  sourceKind: "remote",
                  protocolPresence: ["ap"],
                  ap: { objectUri: "https://remote.example/objects/1" },
                  author: { apUri: "https://remote.example/users/alice" },
                  text: "hello",
                  createdAt: new Date().toISOString(),
                  hasMedia: false,
                  mediaCount: 0,
                  isDeleted: false,
                  indexedAt: new Date().toISOString(),
                },
              },
              {
                _id: "doc-2",
                _source: {
                  stableDocId: "doc-2",
                  sourceKind: "remote",
                  protocolPresence: ["ap"],
                  ap: { objectUri: "javascript:alert(1)" },
                  author: { apUri: "https://remote.example/users/bob" },
                  text: "unsafe",
                  createdAt: new Date().toISOString(),
                  hasMedia: false,
                  mediaCount: 0,
                  isDeleted: false,
                  indexedAt: new Date().toISOString(),
                },
              },
            ],
          },
        },
      }),
    };

    const provider = new OpenSearchFeedProvider(osClient as any, candidateService);
    const result = await provider.getFeed({
      definition,
      request: {
        feedId: definition.id,
        limit: 10,
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      stableId: "doc-1",
      source: "stream2",
      activityPubObjectId: "https://remote.example/objects/1",
      authorId: "https://remote.example/users/alice",
    });
  });

  it("maps graph feeds to home candidate mode and forwards filters", async () => {
    const candidateService: FeedCandidateService = {
      getCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
    };
    const osClient = {
      search: vi.fn(),
    };

    const provider = new OpenSearchFeedProvider(osClient as any, candidateService);
    await provider.getFeed({
      definition: {
        ...definition,
        id: "urn:activitypods:feed:graph:v1",
        kind: "graph",
      },
      request: {
        feedId: "urn:activitypods:feed:graph:v1",
        viewerId: "did:plc:alice",
        limit: 25,
        filters: {
          tags: ["fediverse"],
          authors: ["https://remote.example/users/alice"],
        },
      },
    });

    expect(candidateService.getCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        feedType: "home",
        viewerCanonicalId: "did:plc:alice",
        interests: ["fediverse"],
        followedIds: ["https://remote.example/users/alice"],
      }),
    );
  });

  it("retries transient OpenSearch read errors", async () => {
    const candidateService: FeedCandidateService = {
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [{ stableDocId: "doc-1", score: 1, bucket: "trending" }],
      }),
    };

    const osClient = {
      search: vi
        .fn()
        .mockRejectedValueOnce({ meta: { statusCode: 503 } })
        .mockResolvedValue({
          body: {
            hits: {
              hits: [
                {
                  _id: "doc-1",
                  _source: {
                    stableDocId: "doc-1",
                    sourceKind: "remote",
                    protocolPresence: ["ap"],
                    ap: { objectUri: "https://remote.example/objects/1" },
                    author: { apUri: "https://remote.example/users/alice" },
                    text: "hello",
                    createdAt: new Date().toISOString(),
                    hasMedia: false,
                    mediaCount: 0,
                    isDeleted: false,
                    indexedAt: new Date().toISOString(),
                  },
                },
              ],
            },
          },
        }),
    };

    const provider = new OpenSearchFeedProvider(osClient as any, candidateService, {
      retryPolicy: {
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
      },
      requestTimeoutMs: 1234,
    });

    const result = await provider.getFeed({
      definition,
      request: {
        feedId: definition.id,
        limit: 10,
      },
    });

    expect(result.items).toHaveLength(1);
    expect(osClient.search).toHaveBeenCalledTimes(2);
    expect(osClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ timeout: "1234ms" }),
      }),
    );
  });
});
