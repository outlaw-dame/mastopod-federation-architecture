import { afterEach, describe, expect, it, vi } from "vitest";
import { QdrantFeedCandidateService } from "../queries/QdrantFeedCandidateService.js";
import { QdrantDocumentStore } from "../../feed/QdrantDocumentStore.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("QdrantFeedCandidateService", () => {
  it("emits ordered-scroll cursors and reuses them with tie exclusion", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const authorFiltered = Array.isArray(body.filter?.should) && body.filter.should.length > 0;

      if (authorFiltered && body.order_by?.start_from === undefined) {
        return {
          ok: true,
          json: async () => ({
            result: {
              points: [
                {
                  id: "graph-1",
                  order_value: "2026-01-01T00:00:00.000Z",
                  payload: {
                    stableDocId: "graph-1",
                    sourceKind: "remote",
                    protocolPresence: ["ap"],
                    author: { canonicalId: "did:plc:alice" },
                    text: "a",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    hasMedia: false,
                    mediaCount: 0,
                    isDeleted: false,
                    indexedAt: "2026-01-01T00:00:00.000Z",
                  },
                },
                {
                  id: "graph-2",
                  order_value: "2026-01-01T00:00:00.000Z",
                  payload: {
                    stableDocId: "graph-2",
                    sourceKind: "remote",
                    protocolPresence: ["ap"],
                    author: { canonicalId: "did:plc:alice" },
                    text: "b",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    hasMedia: false,
                    mediaCount: 0,
                    isDeleted: false,
                    indexedAt: "2026-01-01T00:00:00.000Z",
                  },
                },
              ],
            },
          }),
        } as Response;
      }

      if (authorFiltered && body.order_by?.start_from === "2026-01-01T00:00:00.000Z") {
        expect(body.must_not ?? body.filter?.must_not).toEqual([{ has_id: ["graph-1", "graph-2"] }]);
        return {
          ok: true,
          json: async () => ({ result: { points: [] } }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ result: { points: [] } }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const store = new QdrantDocumentStore({
      baseUrl: "http://qdrant.test",
      collectionName: "public-content-v1",
      requestTimeoutMs: 1000,
    });
    const service = new QdrantFeedCandidateService(store);

    const first = await service.getCandidates({
      viewerCanonicalId: "did:plc:viewer",
      feedType: "home",
      limit: 6,
      followedIds: ["did:plc:alice"],
    });

    expect(first.candidates.map((candidate) => candidate.stableDocId)).toContain("graph-1");
    expect(first.nextCursor?.graphCursor).toEqual({
      startFrom: "2026-01-01T00:00:00.000Z",
      excludeIds: ["graph-1", "graph-2"],
    });

    await service.getCandidates({
      viewerCanonicalId: "did:plc:viewer",
      feedType: "home",
      limit: 6,
      followedIds: ["did:plc:alice"],
      cursor: first.nextCursor,
    });
  });
});