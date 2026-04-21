import { describe, expect, it, vi } from "vitest";
import { RedisModerationBridgeStore } from "./store.redis.js";

describe("RedisModerationBridgeStore", () => {
  it("paginates AT labels by index offset instead of score", async () => {
    const redis = {
      zrange: vi.fn().mockResolvedValue(["7", "8"]),
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key.endsWith(":7")) {
          return JSON.stringify({ src: "did:web:test", uri: "did:plc:alice", val: "!warn", cts: "2026-04-20T00:00:00.000Z" });
        }
        if (key.endsWith(":8")) {
          return JSON.stringify({ src: "did:web:test", uri: "did:plc:alice", val: "!hide", cts: "2026-04-20T00:00:01.000Z" });
        }
        return null;
      }),
    };

    const store = new RedisModerationBridgeStore(redis as never, { prefix: "moderation:test" });
    const page = await store.listAtLabels({ limit: 2, cursor: 3, subject: "did:plc:alice" });

    expect(redis.zrange).toHaveBeenCalledWith(
      "moderation:test:label:by-subject:did:plc:alice",
      3,
      4,
    );
    expect(page.labels).toHaveLength(2);
    expect(page.cursor).toBe(5);
  });
});
