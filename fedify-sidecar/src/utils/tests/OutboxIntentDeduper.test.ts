vi.mock("../logger.js", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import { describe, expect, it, vi } from "vitest";
import { OutboxIntentDeduper, extractOutboxIntentId } from "../OutboxIntentDeduper.js";

describe("OutboxIntentDeduper", () => {
  it("dedupes in memory when no shared store is available", async () => {
    let now = 1_000;
    const deduper = new OutboxIntentDeduper({
      prefix: "test",
      ttlSeconds: 60,
      now: () => now,
    });

    await expect(deduper.claim("intent-1")).resolves.toBe(true);
    await expect(deduper.claim("intent-1")).resolves.toBe(false);

    now += 61_000;
    await expect(deduper.claim("intent-1")).resolves.toBe(true);
  });

  it("uses SET NX EX semantics when a shared store is available", async () => {
    const store = {
      set: vi.fn()
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce(null),
    };
    const deduper = new OutboxIntentDeduper({
      prefix: "search",
      ttlSeconds: 30,
      store,
    });

    await expect(deduper.claim("intent-2")).resolves.toBe(true);
    await expect(deduper.claim("intent-2")).resolves.toBe(false);
    expect(store.set).toHaveBeenNthCalledWith(1, "search:intent-2", "1", "EX", 30, "NX");
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
