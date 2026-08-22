import { afterEach, describe, expect, it } from "vitest";
import { CompressionCodecs, CompressionTypes } from "kafkajs";
import {
  hasNativeZstdSupport,
  parseZstdLevel,
  resolveRedpandaCompression,
} from "../kafka-compression.js";

const originalLevel = process.env["REDPANDA_ZSTD_LEVEL"];

afterEach(() => {
  if (originalLevel === undefined) {
    delete process.env["REDPANDA_ZSTD_LEVEL"];
  } else {
    process.env["REDPANDA_ZSTD_LEVEL"] = originalLevel;
  }
});

describe("Redpanda Kafka compression", () => {
  it("recognizes the Node runtime boundary for built-in Zstd", () => {
    expect(hasNativeZstdSupport("20.19.0")).toBe(false);
    expect(hasNativeZstdSupport("22.14.9")).toBe(false);
    expect(hasNativeZstdSupport("22.15.0")).toBe(true);
    expect(hasNativeZstdSupport("22.23.2")).toBe(true);
    expect(hasNativeZstdSupport("23.8.0")).toBe(true);
  });

  it("uses Zstd level 1 by default and validates explicit levels", () => {
    delete process.env["REDPANDA_ZSTD_LEVEL"];
    expect(parseZstdLevel()).toBe(1);
    expect(parseZstdLevel("-5")).toBe(-5);
    expect(parseZstdLevel("3")).toBe(3);
    expect(parseZstdLevel("22")).toBe(22);
    expect(() => parseZstdLevel("1.5")).toThrow(/integer/u);
    expect(() => parseZstdLevel("23")).toThrow(/between/u);
    expect(() => parseZstdLevel("-131073")).toThrow(/between/u);
  });

  it("keeps gzip and none available without optional KafkaJS plugins", () => {
    expect(resolveRedpandaCompression("gzip")).toEqual({
      name: "gzip",
      type: CompressionTypes.GZIP,
    });
    expect(resolveRedpandaCompression("none")).toEqual({
      name: "none",
      type: CompressionTypes.None,
    });
  });

  it("fails closed for codecs Redpanda supports but KafkaJS does not bundle", () => {
    expect(() => resolveRedpandaCompression("lz4")).toThrow(/not bundled by KafkaJS/u);
    expect(() => resolveRedpandaCompression("snappy")).toThrow(/not bundled by KafkaJS/u);
    expect(() => resolveRedpandaCompression("brotli")).toThrow(/Unsupported REDPANDA_COMPRESSION/u);
  });

  it("registers a working native Zstd codec that round-trips representative ActivityPub JSON", async () => {
    const resolved = resolveRedpandaCompression("zstd");
    expect(resolved.name).toBe("zstd");
    expect(resolved.type).toBe(CompressionTypes.ZSTD);
    expect(resolved.zstdLevel).toBe(1);

    const codecFactory = CompressionCodecs[CompressionTypes.ZSTD];
    expect(codecFactory).toBeTypeOf("function");
    const codec = codecFactory!();

    const activity = Buffer.from(JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://pod.example/activities/123",
      type: "Create",
      actor: "https://pod.example/alice",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: "https://pod.example/objects/123",
        type: "Note",
        content: "ActivityPods public stream compression proof ".repeat(300),
        attributedTo: "https://pod.example/alice",
      },
    }));

    const compressed = await codec.compress({ buffer: activity } as never);
    const decompressed = await codec.decompress(compressed);

    expect(Buffer.from(decompressed).equals(activity)).toBe(true);
    expect(compressed.byteLength).toBeLessThan(activity.byteLength);
  });
});
