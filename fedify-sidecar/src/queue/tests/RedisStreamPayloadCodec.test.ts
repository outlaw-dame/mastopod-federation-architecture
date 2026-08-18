import { describe, expect, it } from "vitest";
import {
  REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX,
  RedisStreamPayloadCodec,
} from "../redis-stream-payload-codec.js";

describe("RedisStreamPayloadCodec", () => {
  it("leaves writes plaintext when the feature flag is disabled", () => {
    const codec = new RedisStreamPayloadCodec({ writeEnabled: false, minBytes: 1 });
    const source = JSON.stringify({ type: "Create", content: "activitypub ".repeat(2000) });

    const encoded = codec.encode(source);

    expect(encoded.compressed).toBe(false);
    expect(encoded.value).toBe(source);
    expect(codec.decode(encoded.value)).toBe(source);
  });

  it("compresses a large repetitive payload and round-trips it", () => {
    const codec = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 64 });
    const source = JSON.stringify({ type: "Create", content: "activitypub ".repeat(2000) });

    const encoded = codec.encode(source);

    expect(encoded.compressed).toBe(true);
    expect(encoded.value.startsWith(REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX)).toBe(true);
    expect(encoded.storedBytes).toBeLessThan(encoded.sourceBytes);
    expect(codec.decode(encoded.value)).toBe(source);
  });

  it("keeps small payloads plaintext", () => {
    const codec = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 4096 });
    const source = '{"type":"Like"}';

    expect(codec.encode(source)).toMatchObject({ value: source, compressed: false });
  });

  it("rejects unknown versioned compression envelopes", () => {
    const codec = new RedisStreamPayloadCodec();

    expect(() => codec.decode("apq1:zstd:not-supported")).toThrow(/unknown compression envelope/u);
  });

  it("rejects corrupt Brotli payloads", () => {
    const codec = new RedisStreamPayloadCodec();

    expect(() => codec.decode(`${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}bm90LWJyb3RsaQ`)).toThrow(
      /could not be decompressed/u,
    );
  });

  it("enforces the maximum decompressed payload size", () => {
    const writer = new RedisStreamPayloadCodec({
      writeEnabled: true,
      minBytes: 1,
      maxDecompressedBytes: 1024 * 1024,
    });
    const reader = new RedisStreamPayloadCodec({ maxDecompressedBytes: 128 });
    const source = "x".repeat(4096);
    const encoded = writer.encode(source);
    expect(encoded.compressed).toBe(true);

    expect(() => reader.decode(encoded.value)).toThrow(/could not be decompressed|maximum/u);
  });

  it("refuses to encode a payload above the configured uncompressed ceiling", () => {
    const codec = new RedisStreamPayloadCodec({
      writeEnabled: true,
      minBytes: 1,
      maxDecompressedBytes: 128,
    });

    expect(() => codec.encode("x".repeat(129))).toThrow(/maximum uncompressed size/u);
  });

  it("does not keep a compressed envelope when it is larger than plaintext", () => {
    const codec = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 1 });
    const source = "0123456789abcdef";

    const encoded = codec.encode(source);

    expect(encoded.value.length).toBeLessThanOrEqual(source.length);
    if (!encoded.compressed) expect(encoded.value).toBe(source);
  });
});
