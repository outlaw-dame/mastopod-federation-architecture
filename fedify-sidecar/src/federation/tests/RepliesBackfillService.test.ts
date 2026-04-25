/**
 * Tests for RepliesBackfillService and its pure helper functions.
 */

vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  RepliesBackfillService,
  extractRepliesUri,
  extractContextCollectionUri,
  extractContextHistoryUri,
  extractHistoryCollectionUri,
  extractItems,
  extractNextUri,
  extractId,
  extractAttributedTo,
} from "../replies-backfill/RepliesBackfillService.js";

// ============================================================================
// Pure helper tests
// ============================================================================

describe("extractRepliesUri", () => {
  it("returns string URI directly", () => {
    expect(extractRepliesUri({ replies: "https://example.com/note/1/replies" }))
      .toBe("https://example.com/note/1/replies");
  });

  it("returns id from object form", () => {
    expect(extractRepliesUri({ replies: { id: "https://example.com/note/1/replies", type: "Collection" } }))
      .toBe("https://example.com/note/1/replies");
  });

  it("returns null for missing replies", () => {
    expect(extractRepliesUri({ type: "Note" })).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(extractRepliesUri(null)).toBeNull();
    expect(extractRepliesUri("string")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRepliesUri({ replies: "" })).toBeNull();
  });
});

describe("extractContextHistoryUri", () => {
  it("returns contextHistory string URI", () => {
    expect(extractContextHistoryUri({ contextHistory: "https://example.com/posts/1/context/history" }))
      .toBe("https://example.com/posts/1/context/history");
  });

  it("returns contextHistory object id URI", () => {
    expect(extractContextHistoryUri({ contextHistory: { id: "https://example.com/posts/1/context/history" } }))
      .toBe("https://example.com/posts/1/context/history");
  });

  it("returns null for non-http values", () => {
    expect(extractContextHistoryUri({ contextHistory: "urn:test:history" })).toBeNull();
  });
});

describe("extractContextCollectionUri", () => {
  it("returns context string URI", () => {
    expect(extractContextCollectionUri({ context: "https://example.com/posts/1/context" }))
      .toBe("https://example.com/posts/1/context");
  });

  it("returns context object id URI", () => {
    expect(extractContextCollectionUri({ context: { id: "https://example.com/posts/1/context" } }))
      .toBe("https://example.com/posts/1/context");
  });

  it("returns null for non-http values", () => {
    expect(extractContextCollectionUri({ context: "not-a-url" })).toBeNull();
  });
});

describe("extractHistoryCollectionUri", () => {
  it("returns history URI from compact key", () => {
    expect(extractHistoryCollectionUri({ history: "https://example.com/posts/1/context/history" }))
      .toBe("https://example.com/posts/1/context/history");
  });

  it("returns history URI from expanded bad1 key", () => {
    expect(extractHistoryCollectionUri({
      "https://w3id.org/fep/bad1#history": {
        id: "https://example.com/posts/1/context/history",
      },
    })).toBe("https://example.com/posts/1/context/history");
  });

  it("returns null for non-http values", () => {
    expect(extractHistoryCollectionUri({ history: "urn:history:test" })).toBeNull();
  });
});

describe("extractItems", () => {
  it("prefers orderedItems over items", () => {
    expect(extractItems({
      orderedItems: ["https://a.com/1", "https://a.com/2"],
      items: ["https://b.com/3"],
    })).toEqual(["https://a.com/1", "https://a.com/2"]);
  });

  it("falls back to items", () => {
    expect(extractItems({ items: ["https://a.com/1"] }))
      .toEqual(["https://a.com/1"]);
  });

  it("extracts id from object items", () => {
    expect(extractItems({
      orderedItems: [
        "https://a.com/1",
        { id: "https://a.com/2", type: "Note" },
        { noId: true },
      ],
    })).toEqual(["https://a.com/1", "https://a.com/2"]);
  });

  it("returns empty for missing items", () => {
    expect(extractItems({})).toEqual([]);
  });

  it("returns empty for non-array items", () => {
    expect(extractItems({ items: "not-an-array" })).toEqual([]);
  });
});

describe("extractNextUri", () => {
  it("returns string next", () => {
    expect(extractNextUri({ next: "https://a.com/page2" }, "next"))
      .toBe("https://a.com/page2");
  });

  it("returns id from object next", () => {
    expect(extractNextUri({ next: { id: "https://a.com/page2" } }, "next"))
      .toBe("https://a.com/page2");
  });

  it("returns string first", () => {
    expect(extractNextUri({ first: "https://a.com/page1" }, "first"))
      .toBe("https://a.com/page1");
  });

  it("returns null when key missing", () => {
    expect(extractNextUri({}, "next")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractNextUri({ next: "" }, "next")).toBeNull();
  });
});

describe("extractId", () => {
  it("returns id string", () => {
    expect(extractId({ id: "https://a.com/1" })).toBe("https://a.com/1");
  });

  it("returns null for non-string id", () => {
    expect(extractId({ id: 42 })).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(extractId(null)).toBeNull();
  });
});

describe("extractAttributedTo", () => {
  it("returns string attributedTo", () => {
    expect(extractAttributedTo({ attributedTo: "https://a.com/user/1" }))
      .toBe("https://a.com/user/1");
  });

  it("returns id from object attributedTo", () => {
    expect(extractAttributedTo({ attributedTo: { id: "https://a.com/user/1" } }))
      .toBe("https://a.com/user/1");
  });

  it("falls back to actor field", () => {
    expect(extractAttributedTo({ actor: "https://a.com/user/1" }))
      .toBe("https://a.com/user/1");
  });

  it("returns null when neither present", () => {
    expect(extractAttributedTo({})).toBeNull();
  });
});

// ============================================================================
// Service integration tests (with mocked signing and queue)
// ============================================================================

describe("RepliesBackfillService", () => {
  let mockSigningClient: any;
  let mockQueue: any;
  let service: RepliesBackfillService;

  const makeSignResult = () => ({
    ok: true,
    signedHeaders: { date: "Thu, 01 Jan 2025 00:00:00 GMT", signature: "sig=mock" },
  });

  beforeEach(() => {
    mockSigningClient = {
      signOne: vi.fn().mockResolvedValue(makeSignResult()),
    };
    mockQueue = {
      enqueueInbound: vi.fn().mockResolvedValue(undefined),
    };
    service = new RepliesBackfillService(mockSigningClient, mockQueue, {
      signerActorUri: "https://social.example.com/users/relay",
      maxPagesPerCollection: 2,
      maxRepliesPerThread: 5,
      maxDepth: 1,
      cooldownSeconds: 60,
    });
  });

  it("skips notes without replies property", async () => {
    await service.triggerFromNote({ type: "Note", id: "https://a.com/1" });
    expect(mockSigningClient.signOne).not.toHaveBeenCalled();
    expect(mockQueue.enqueueInbound).not.toHaveBeenCalled();
  });

  it("skips null input", async () => {
    await service.triggerFromNote(null);
    expect(mockSigningClient.signOne).not.toHaveBeenCalled();
  });

  it("does not throw on signing failure", async () => {
    mockSigningClient.signOne.mockResolvedValue({ ok: false, error: { message: "fail" } });

    // Won't throw — errors are swallowed
    await service.triggerFromNote({
      type: "Note",
      id: "https://a.com/1",
      replies: "https://a.com/1/replies",
    });

    expect(mockSigningClient.signOne).toHaveBeenCalled();
    expect(mockQueue.enqueueInbound).not.toHaveBeenCalled();
  });
});
