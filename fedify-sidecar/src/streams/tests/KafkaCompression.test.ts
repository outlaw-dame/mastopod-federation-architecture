import { afterEach, describe, expect, it } from "vitest";
import kafkaJs from "kafkajs";
import {
  defaultRedpandaCompressionName,
  ensureRedpandaCompressionCodec,
  hasNativeZstdSupport,
  parseZstdLevel,
  resolveConfiguredRedpandaCompression,
  resolveRedpandaCompression,
} from "../kafka-compression.js";

const { CompressionCodecs, CompressionTypes } = kafkaJs;
const originalCompression = process.env["REDPANDA_COMPRESSION"];
const originalLevel = process.env["REDPANDA_ZSTD_LEVEL"];

afterEach(() => {
  if (originalCompression === undefined) {
    delete process.env["REDPANDA_COMPRESSION"];
  } else {
    process.env["REDPANDA_COMPRESSION"] = originalCompression;
  }
  if (originalLevel === undefined) {
    delete process.env["REDPANDA_ZSTD_LEVEL"];
  } else {
    process.env["REDPANDA_ZSTD_LEVEL"] = originalLevel;
  }
});

describe("Redpanda Kafka compression", () => {
  it("recognizes the exact Node runtime boundaries for built-in Zstd", () => {
    expect(hasNativeZstdSupport("20.19.0")).toBe(false);
    expect(hasNativeZstdSupport("21.7.3")).toBe(false);
    expect(hasNativeZstdSupport("22.14.9")).toBe(false);
    expect(hasNativeZstdSupport("22.15.0")).toBe(true);
    expect(hasNativeZstdSupport("22.23.2")).toBe(true);
    expect(hasNativeZstdSupport("23.0.0")).toBe(false);
    expect(hasNativeZstdSupport("23.7.9")).toBe(false);
    expect(hasNativeZstdSupport("23.8.0")).toBe(true);
    expect(hasNativeZstdSupport("24.0.0")).toBe(true);
  });

  it("keeps gzip as the package-level rolling-upgrade-safe default", () => {
    delete process.env["REDPANDA_COMPRESSION"];
    expect(defaultRedpandaCompressionName()).toBe("gzip");
    expect(resolveRedpandaCompression()).toMatchObject({
      name: "gzip",
      type: CompressionTypes.GZIP,
    });
    // Legacy call sites historically supplied env ?? "zstd". That must not
    // silently opt a mixed Node 20/22 fleet into a codec older consumers lack.
    expect(resolveConfiguredRedpandaCompression("zstd")).toMatchObject({
      name: "gzip",
      type: CompressionTypes.GZIP,
    });
    expect(ensureRedpandaCompressionCodec("zstd")).toBe(CompressionTypes.GZIP);
  });

  it("keeps an explicitly configured process-wide Zstd setting authoritative", () => {
    process.env["REDPANDA_COMPRESSION"] = "zstd";
    expect(resolveConfiguredRedpandaCompression("gzip")).toMatchObject({
      name: "zstd",
      type: CompressionTypes.ZSTD,
      zstdLevel: 2,
    });
  });

  it("uses benchmark-selected Zstd level 2 by default and validates explicit levels", () => {
    delete process.env["REDPANDA_ZSTD_LEVEL"];
    expect(parseZstdLevel()).toBe(2);
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
    process.env["REDPANDA_COMPRESSION"] = "zstd";
    const resolved = resolveRedpandaCompression();
    expect(resolved.name).toBe("zstd");
    expect(resolved.type).toBe(CompressionTypes.ZSTD);
    expect(resolved.zstdLevel).toBe(2);

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

  it("keeps the Zstd decoder registered after switching new writes to gzip", () => {
    process.env["REDPANDA_COMPRESSION"] = "zstd";
    resolveRedpandaCompression();
    process.env["REDPANDA_COMPRESSION"] = "gzip";
    expect(resolveRedpandaCompression()).toMatchObject({
      name: "gzip",
      type: CompressionTypes.GZIP,
    });
    expect(CompressionCodecs[CompressionTypes.ZSTD]).toBeTypeOf("function");
  });
});
