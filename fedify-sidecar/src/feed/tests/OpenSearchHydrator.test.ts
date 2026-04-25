import { describe, expect, it, vi } from "vitest";
import { OpenSearchHydrator } from "../OpenSearchHydrator.js";

describe("OpenSearchHydrator", () => {
  it("hydrates safe records and omits missing ones", async () => {
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
                  author: { apUri: "https://remote.example/users/alice", displayName: "Alice" },
                  text: "hello\u0001world",
                  createdAt: new Date().toISOString(),
                  hasMedia: false,
                  mediaCount: 0,
                  engagement: { likeCount: 12, repostCount: 2, replyCount: 1 },
                  isDeleted: false,
                  indexedAt: new Date().toISOString(),
                },
              },
            ],
          },
        },
      }),
    };

    const hydrator = new OpenSearchHydrator(osClient as any);
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
    const first = result.items[0];
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      id: "https://remote.example/objects/1",
      type: "Note",
      provenance: { source: "stream2" },
    });
    expect(first?.content?.text).toBe("helloworld");
    expect(result.omitted).toEqual([{ id: "missing", reason: "not_found" }]);
  });

  it("marks records with no safe canonical identifier as invalid_request", async () => {
    const osClient = {
      search: vi.fn().mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _id: "doc-unsafe",
                _source: {
                  stableDocId: "doc-unsafe",
                  sourceKind: "remote",
                  protocolPresence: ["ap"],
                  ap: { objectUri: "javascript:alert(1)" },
                  author: { did: "did:plc:alice" },
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

    const hydrator = new OpenSearchHydrator(osClient as any);
    const result = await hydrator.hydrate({
      request: {
        shape: "card",
        items: [{ stableId: "doc-unsafe", source: "stream2" }],
      },
      items: [{ stableId: "doc-unsafe", source: "stream2" }],
    });

    expect(result.items).toHaveLength(0);
    expect(result.omitted).toEqual([{ id: "doc-unsafe", reason: "invalid_request" }]);
  });

  it("retries transient OpenSearch errors during hydration", async () => {
    const osClient = {
      search: vi
        .fn()
        .mockRejectedValueOnce({ statusCode: 503 })
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

    const hydrator = new OpenSearchHydrator(osClient as any, {
      retryPolicy: {
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
      },
      requestTimeoutMs: 2468,
    });

    const result = await hydrator.hydrate({
      request: {
        shape: "card",
        items: [{ stableId: "doc-1", source: "stream2" }],
      },
      items: [{ stableId: "doc-1", source: "stream2" }],
    });

    expect(result.items).toHaveLength(1);
    expect(osClient.search).toHaveBeenCalledTimes(2);
    expect(osClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ timeout: "2468ms" }),
      }),
    );
  });
});
