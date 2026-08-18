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
    expect(encoded.value).toMatch(/^apq1:br:[a-f0-9]{64}:[A-Za-z0-9_-]+$/u);
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

  it("rejects malformed Brotli envelopes", () => {
    const codec = new RedisStreamPayloadCodec();

    expect(() => codec.decode(`${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}missing-fields`)).toThrow(
      /envelope is malformed/u,
    );
  });

  it("rejects non-base64url payload bytes before decoding", () => {
    const codec = new RedisStreamPayloadCodec();
    const digest = "0".repeat(64);

    expect(() => codec.decode(`${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}${digest}:%%%`)).toThrow(
      /not valid base64url/u,
    );
  });

  it("rejects corrupt Brotli payloads", () => {
    const codec = new RedisStreamPayloadCodec();
    const digest = "0".repeat(64);

    expect(() => codec.decode(
      `${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}${digest}:bm90LWJyb3RsaQ`,
    )).toThrow(/could not be decompressed/u);
  });

  it("verifies SHA-256 integrity after successful decompression", () => {
    const codec = new RedisStreamPayloadCodec({ writeEnabled: true, minBytes: 1 });
    const source = "activitypub ".repeat(2000);
    const encoded = codec.encode(source);
    expect(encoded.compressed).toBe(true);

    const firstSeparator = encoded.value.indexOf(":", REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX.length);
    const payload = encoded.value.slice(firstSeparator + 1);
    const tampered = `${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}${"0".repeat(64)}:${payload}`;

    expect(() => codec.decode(tampered)).toThrow(/SHA-256 integrity verification/u);
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
