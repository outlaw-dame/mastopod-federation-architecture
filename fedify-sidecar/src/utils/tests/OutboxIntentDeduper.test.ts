vi.mock("../logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { OutboxIntentDeduper, extractOutboxIntentId } from "../OutboxIntentDeduper.js";

describe("OutboxIntentDeduper", () => {
  it("checks completion without mutating the in-memory marker", async () => {
    let now = 1_000;
    const deduper = new OutboxIntentDeduper({
      prefix: "test",
      ttlSeconds: 60,
      now: () => now,
    });

    await expect(deduper.has("intent-1")).resolves.toBe(false);
    await expect(deduper.claim("intent-1")).resolves.toBe(true);
    await expect(deduper.has("intent-1")).resolves.toBe(true);
    await expect(deduper.claim("intent-1")).resolves.toBe(false);

    now += 61_000;
    await expect(deduper.has("intent-1")).resolves.toBe(false);
    await expect(deduper.claim("intent-1")).resolves.toBe(true);
  });

  it("uses GET for completion checks and SET NX EX for completion recording", async () => {
    const store = {
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("1"),
      set: vi.fn().mockResolvedValue("OK"),
    };
    const deduper = new OutboxIntentDeduper({
      prefix: "search",
      ttlSeconds: 30,
      store,
    });

    await expect(deduper.has("intent-2")).resolves.toBe(false);
    await expect(deduper.claim("intent-2")).resolves.toBe(true);
    await expect(deduper.has("intent-2")).resolves.toBe(true);

    expect(store.get).toHaveBeenNthCalledWith(1, "search:intent-2");
    expect(store.set).toHaveBeenCalledWith("search:intent-2", "1", "EX", 30, "NX");
  });

  it("falls back to memory when a shared completion read is unavailable", async () => {
    const store = {
      get: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      set: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const deduper = new OutboxIntentDeduper({
      prefix: "search",
      ttlSeconds: 30,
      store,
    });

    await expect(deduper.has("intent-3")).resolves.toBe(false);
    await expect(deduper.claim("intent-3")).resolves.toBe(true);
    await expect(deduper.has("intent-3")).resolves.toBe(true);
  });
});

describe("extractOutboxIntentId", () => {
  it("prefers Kafka headers over payload fields", () => {
    const extracted = extractOutboxIntentId(
      { outboxIntentId: "payload-intent" },
      { "outbox-intent-id": Buffer.from("header-intent", "utf8") },
    );
    expect(extracted).toBe("header-intent");
  });

  it("falls back to the JSON payload when headers are absent", () => {
    expect(extractOutboxIntentId({ outboxIntentId: "payload-intent" })).toBe("payload-intent");
  });
});
