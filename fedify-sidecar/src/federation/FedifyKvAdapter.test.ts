import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { FedifyKvAdapter } from "./FedifyKvAdapter.js";

describe("FedifyKvAdapter.list", () => {
  it("batches value reads once per SCAN page and preserves yielded entries", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["17", ["fedify:kv:actors:alice", "fedify:kv:actors:bob"]])
      .mockResolvedValueOnce(["0", ["fedify:kv:actors:carol"]]);
    const mget = vi
      .fn()
      .mockResolvedValueOnce([JSON.stringify({ id: "alice" }), JSON.stringify({ id: "bob" })])
      .mockResolvedValueOnce([JSON.stringify({ id: "carol" })]);
    const get = vi.fn();

    const redis = { scan, mget, get } as unknown as Redis;
    const adapter = new FedifyKvAdapter(redis);
    const entries = [];

    for await (const entry of adapter.list(["actors"])) {
      entries.push(entry);
    }

    expect(entries).toEqual([
      { key: ["actors", "alice"], value: { id: "alice" } },
      { key: ["actors", "bob"], value: { id: "bob" } },
      { key: ["actors", "carol"], value: { id: "carol" } },
    ]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(mget).toHaveBeenNthCalledWith(
      1,
      "fedify:kv:actors:alice",
      "fedify:kv:actors:bob",
    );
    expect(mget).toHaveBeenNthCalledWith(2, "fedify:kv:actors:carol");
    expect(get).not.toHaveBeenCalled();
  });

  it("skips keys that expire between SCAN and MGET without changing other entries", async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue([
        "0",
        ["fedify:kv:queue:first", "fedify:kv:queue:expired", "fedify:kv:queue:last"],
      ]),
      mget: vi.fn().mockResolvedValue(["plain", null, JSON.stringify({ ok: true })]),
    } as unknown as Redis;

    const adapter = new FedifyKvAdapter(redis);
    const entries = [];

    for await (const entry of adapter.list(["queue"])) {
      entries.push(entry);
    }

    expect(entries).toEqual([
      { key: ["queue", "first"], value: "plain" },
      { key: ["queue", "last"], value: { ok: true } },
    ]);
  });

  it("does not issue MGET for an empty SCAN page", async () => {
    const mget = vi.fn();
    const redis = {
      scan: vi.fn().mockResolvedValue(["0", []]),
      mget,
    } as unknown as Redis;

    const adapter = new FedifyKvAdapter(redis);
    const entries = [];

    for await (const entry of adapter.list(["missing"])) {
      entries.push(entry);
    }

    expect(entries).toEqual([]);
    expect(mget).not.toHaveBeenCalled();
  });
});