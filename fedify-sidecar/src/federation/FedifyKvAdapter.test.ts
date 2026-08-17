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

  it("includes the exact prefix key and descendants but excludes component siblings before MGET", async () => {
    const mget = vi.fn().mockResolvedValue([
      JSON.stringify({ kind: "root" }),
      JSON.stringify({ kind: "child" }),
    ]);
    const redis = {
      scan: vi.fn().mockResolvedValue([
        "0",
        [
          "fedify:kv:actors",
          "fedify:kv:actors:alice",
          "fedify:kv:actors2",
          "fedify:kv:actorship:bob",
        ],
      ]),
      mget,
    } as unknown as Redis;

    const adapter = new FedifyKvAdapter(redis);
    const entries = [];

    for await (const entry of adapter.list(["actors"])) {
      entries.push(entry);
    }

    expect(mget).toHaveBeenCalledOnce();
    expect(mget).toHaveBeenCalledWith(
      "fedify:kv:actors",
      "fedify:kv:actors:alice",
    );
    expect(entries).toEqual([
      { key: ["actors"], value: { kind: "root" } },
      { key: ["actors", "alice"], value: { kind: "child" } },
    ]);
  });

  it("escapes Redis glob metacharacters in encoded component prefixes", async () => {
    const scan = vi.fn().mockResolvedValue([
      "0",
      ["fedify:kv:a*:child", "fedify:kv:ab:child"],
    ]);
    const mget = vi.fn().mockResolvedValue([JSON.stringify({ ok: true })]);
    const redis = { scan, mget } as unknown as Redis;

    const adapter = new FedifyKvAdapter(redis);
    const entries = [];

    for await (const entry of adapter.list(["a*"])) {
      entries.push(entry);
    }

    expect(scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "fedify:kv:a\\**",
      "COUNT",
      100,
    );
    expect(mget).toHaveBeenCalledWith("fedify:kv:a*:child");
    expect(entries).toEqual([
      { key: ["a*", "child"], value: { ok: true } },
    ]);
  });

  it("treats an omitted prefix as root enumeration", async () => {
    const scan = vi.fn().mockResolvedValue([
      "0",
      ["fedify:kv:actors:alice", "fedify:kv:queue:first"],
    ]);
    const mget = vi.fn().mockResolvedValue([
      JSON.stringify({ id: "alice" }),
      "plain",
    ]);
    const redis = { scan, mget } as unknown as Redis;
    const adapter = new FedifyKvAdapter(redis);
    const entries = [];

    for await (const entry of adapter.list()) {
      entries.push(entry);
    }

    expect(scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "fedify:kv:*",
      "COUNT",
      100,
    );
    expect(mget).toHaveBeenCalledWith(
      "fedify:kv:actors:alice",
      "fedify:kv:queue:first",
    );
    expect(entries).toEqual([
      { key: ["actors", "alice"], value: { id: "alice" } },
      { key: ["queue", "first"], value: "plain" },
    ]);
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

  it("does not issue MGET for an empty or sibling-only SCAN page", async () => {
    const mget = vi.fn();
    const redis = {
      scan: vi
        .fn()
        .mockResolvedValueOnce(["9", ["fedify:kv:missingSibling"]])
        .mockResolvedValueOnce(["0", []]),
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