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

  it("releases an in-memory claim so a failed side effect can retry", async () => {
    const deduper = new OutboxIntentDeduper({ prefix: "test", ttlSeconds: 60 });
    await expect(deduper.claim("intent-retry")).resolves.toBe(true);
    await deduper.release("intent-retry");
    await expect(deduper.claim("intent-retry")).resolves.toBe(true);
  });

  it("uses SET NX EX and DEL semantics with a shared store", async () => {
    const store = {
      set: vi.fn()
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("OK"),
      del: vi.fn().mockResolvedValue(1),
    };
    const deduper = new OutboxIntentDeduper({
      prefix: "search",
      ttlSeconds: 30,
      store,
    });

    await expect(deduper.claim("intent-2")).resolves.toBe(true);
    await expect(deduper.claim("intent-2")).resolves.toBe(false);
    expect(store.set).toHaveBeenNthCalledWith(1, "search:intent-2", "1", "EX", 30, "NX");

    await deduper.release("intent-2");
    expect(store.del).toHaveBeenCalledWith("search:intent-2");
    await expect(deduper.claim("intent-2")).resolves.toBe(true);
  });

  it("fails closed when a shared store cannot release a durable claim", async () => {
    const deduper = new OutboxIntentDeduper({
      prefix: "search",
      ttlSeconds: 30,
      store: { set: vi.fn().mockResolvedValue("OK") },
    });
    await expect(deduper.claim("intent-3")).resolves.toBe(true);
    await expect(deduper.release("intent-3")).rejects.toThrow(/does not support release/);
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
