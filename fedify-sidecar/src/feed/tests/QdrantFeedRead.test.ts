import { afterEach, describe, expect, it, vi } from "vitest";
import { QdrantFeedProvider } from "../QdrantFeedProvider.js";
import { QdrantHydrator } from "../QdrantHydrator.js";
import type { FeedCandidateService } from "../../search/queries/FeedCandidateService.js";
import type { FeedDefinition } from "../contracts.js";

const config = {
  baseUrl: "http://qdrant.test",
  collectionName: "public-content-v1",
  requestTimeoutMs: 1000,
};

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
  providerId: "search.candidates.v1",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Qdrant read path", () => {
  it("returns safe feed skeletons from Qdrant point retrieval", async () => {
    const candidateService: FeedCandidateService = {
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [{ stableDocId: "doc-1", score: 1.3, bucket: "trending" }],
      }),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              id: "doc-1",
              payload: {
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
        }),
      }),
    );

    const provider = new QdrantFeedProvider(config, candidateService);
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
    expect(fetch).toHaveBeenCalledWith(
      "http://qdrant.test/collections/public-content-v1/points",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("hydrates safe records from Qdrant retrieval and omits missing ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              id: "doc-1",
              payload: {
                stableDocId: "doc-1",
                sourceKind: "remote",
                protocolPresence: ["ap"],
                ap: { objectUri: "https://remote.example/objects/1" },
                author: { apUri: "https://remote.example/users/alice", displayName: "Alice" },
                text: "hello\u0001world",
                createdAt: new Date().toISOString(),
                hasMedia: false,
                mediaCount: 0,
                engagement: { likeCount: 5, repostCount: 2, replyCount: 1 },
                isDeleted: false,
                indexedAt: new Date().toISOString(),
              },
            },
          ],
        }),
      }),
    );

    const hydrator = new QdrantHydrator(config);
    const result = await hydrator.hydrate({
      request: {
        shape: "card",
        items: [
          { stableId: "doc-1", source: "stream2" },
          { stableId: "missing", source: "stream2" },
        ],
      },
      items: [
        { stableId: "doc-1", source: "stream2" },
        { stableId: "missing", source: "stream2" },
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "https://remote.example/objects/1",
      provenance: { source: "stream2" },
    });
    expect(result.items[0]?.content?.text).toBe("helloworld");
    expect(result.omitted).toEqual([{ id: "missing", reason: "not_found" }]);
  });
});