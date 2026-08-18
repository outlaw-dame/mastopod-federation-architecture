import { createHash } from "node:crypto";
import { constants, brotliCompressSync, brotliDecompressSync } from "node:zlib";

export const REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX = "apq1:br:";
export const REDIS_STREAM_PAYLOAD_UNKNOWN_PREFIX = "apq1:";
export const DEFAULT_REDIS_STREAM_COMPRESSION_MIN_BYTES = 4 * 1024;
export const DEFAULT_REDIS_STREAM_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_REDIS_STREAM_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REDIS_STREAM_DECODE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface RedisStreamPayloadCodecConfig {
  writeEnabled?: boolean;
  minBytes?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  brotliQuality?: number;
  decodeCacheMaxBytes?: number;
}

export interface EncodedRedisStreamPayload {
  value: string;
  compressed: boolean;
  sourceBytes: number;
  storedBytes: number;
}

type DecodeCacheEntry = { value: string; bytes: number };

function finitePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function boundedBrotliQuality(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(11, Math.floor(value)));
}

function payloadDigest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export class RedisStreamPayloadCodec {
  private readonly writeEnabled: boolean;
  private readonly minBytes: number;
  private readonly maxCompressedBytes: number;
  private readonly maxDecompressedBytes: number;
  private readonly brotliQuality: number;
  private readonly decodeCacheMaxBytes: number;
  private readonly decodeCache = new Map<string, DecodeCacheEntry>();
  private decodeCacheBytes = 0;

  constructor(config: RedisStreamPayloadCodecConfig = {}) {
    this.writeEnabled = config.writeEnabled === true;
    this.minBytes = finitePositiveInteger(
      config.minBytes,
      DEFAULT_REDIS_STREAM_COMPRESSION_MIN_BYTES,
    );
    this.maxCompressedBytes = finitePositiveInteger(
      config.maxCompressedBytes,
      DEFAULT_REDIS_STREAM_MAX_COMPRESSED_BYTES,
    );
    this.maxDecompressedBytes = finitePositiveInteger(
      config.maxDecompressedBytes,
      DEFAULT_REDIS_STREAM_MAX_DECOMPRESSED_BYTES,
    );
    this.brotliQuality = boundedBrotliQuality(config.brotliQuality);
    this.decodeCacheMaxBytes = finitePositiveInteger(
      config.decodeCacheMaxBytes,
      DEFAULT_REDIS_STREAM_DECODE_CACHE_MAX_BYTES,
    );
  }

  encode(value: string): EncodedRedisStreamPayload {
    const source = Buffer.from(value);
    const sourceBytes = source.byteLength;
    if (!this.writeEnabled || sourceBytes < this.minBytes) {
      return { value, compressed: false, sourceBytes, storedBytes: sourceBytes };
    }
    if (sourceBytes > this.maxDecompressedBytes) {
      throw new Error(
        `Redis Stream payload exceeds maximum uncompressed size of ${this.maxDecompressedBytes} bytes`,
      );
    }

    const compressed = brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: this.brotliQuality,
      },
    });
    if (compressed.byteLength > this.maxCompressedBytes) {
      throw new Error(
        `Redis Stream compressed payload exceeds maximum size of ${this.maxCompressedBytes} bytes`,
      );
    }

    const encoded = `${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}${payloadDigest(source)}:${compressed.toString("base64url")}`;
    const storedBytes = Buffer.byteLength(encoded);

    if (storedBytes >= sourceBytes) {
      return { value, compressed: false, sourceBytes, storedBytes: sourceBytes };
    }

    return { value: encoded, compressed: true, sourceBytes, storedBytes };
  }

  decode(value: string): string {
    if (!value.startsWith(REDIS_STREAM_PAYLOAD_UNKNOWN_PREFIX)) return value;
    if (!value.startsWith(REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX)) {
      throw new Error("Redis Stream payload uses an unknown compression envelope");
    }

    const envelope = value.slice(REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX.length);
    const separator = envelope.indexOf(":");
    if (separator <= 0 || separator === envelope.length - 1) {
      throw new Error("Redis Stream Brotli payload envelope is malformed");
    }

    const expectedDigest = envelope.slice(0, separator);
    const encoded = envelope.slice(separator + 1);
    if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
      throw new Error("Redis Stream Brotli payload digest is malformed");
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw new Error("Redis Stream Brotli payload is not valid base64url");
    }

    const maxEncodedLength = Math.ceil((this.maxCompressedBytes * 4) / 3) + 2;
    if (encoded.length > maxEncodedLength) {
      throw new Error(
        `Redis Stream compressed payload exceeds maximum size of ${this.maxCompressedBytes} bytes`,
      );
    }

    const compressed = Buffer.from(encoded, "base64url");
    if (compressed.byteLength === 0 || compressed.toString("base64url") !== encoded) {
      throw new Error("Redis Stream Brotli payload is not canonical base64url");
    }
    if (compressed.byteLength > this.maxCompressedBytes) {
      throw new Error(
        `Redis Stream compressed payload exceeds maximum size of ${this.maxCompressedBytes} bytes`,
      );
    }

    // Bind reuse to both the advertised uncompressed digest and the exact
    // canonical compressed bytes so cache hits cannot mask payload corruption.
    const cacheKey = `${expectedDigest}:${payloadDigest(compressed)}`;
    const cached = this.decodeCache.get(cacheKey);
    if (cached !== undefined) {
      this.decodeCache.delete(cacheKey);
      this.decodeCache.set(cacheKey, cached);
      return cached.value;
    }

    let decompressed: Buffer;
    try {
      decompressed = brotliDecompressSync(compressed, {
        maxOutputLength: this.maxDecompressedBytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Redis Stream Brotli payload could not be decompressed: ${message}`);
    }

    if (decompressed.byteLength > this.maxDecompressedBytes) {
      throw new Error(
        `Redis Stream decompressed payload exceeds maximum size of ${this.maxDecompressedBytes} bytes`,
      );
    }
    if (payloadDigest(decompressed) !== expectedDigest) {
      throw new Error("Redis Stream Brotli payload failed SHA-256 integrity verification");
    }

    const decoded = decompressed.toString("utf8");
    this.cacheDecoded(cacheKey, decoded, decompressed.byteLength);
    return decoded;
  }

  private cacheDecoded(key: string, value: string, bytes: number): void {
    if (bytes > this.decodeCacheMaxBytes) return;
    const existing = this.decodeCache.get(key);
    if (existing) {
      this.decodeCacheBytes -= existing.bytes;
      this.decodeCache.delete(key);
    }
    while (this.decodeCacheBytes + bytes > this.decodeCacheMaxBytes && this.decodeCache.size > 0) {
      const oldestKey = this.decodeCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.decodeCache.get(oldestKey);
      if (oldest) this.decodeCacheBytes -= oldest.bytes;
      this.decodeCache.delete(oldestKey);
    }
    this.decodeCache.set(key, { value, bytes });
    this.decodeCacheBytes += bytes;
  }
}

export function createRedisStreamPayloadCodecFromEnv(): RedisStreamPayloadCodec {
  return new RedisStreamPayloadCodec({
    writeEnabled: process.env["REDIS_STREAM_PAYLOAD_COMPRESSION_ENABLED"] === "true",
    minBytes: Number.parseInt(
      process.env["REDIS_STREAM_PAYLOAD_COMPRESSION_MIN_BYTES"] ||
        String(DEFAULT_REDIS_STREAM_COMPRESSION_MIN_BYTES),
      10,
    ),
    maxCompressedBytes: Number.parseInt(
      process.env["REDIS_STREAM_PAYLOAD_MAX_COMPRESSED_BYTES"] ||
        String(DEFAULT_REDIS_STREAM_MAX_COMPRESSED_BYTES),
      10,
    ),
    maxDecompressedBytes: Number.parseInt(
      process.env["REDIS_STREAM_PAYLOAD_MAX_DECOMPRESSED_BYTES"] ||
        String(DEFAULT_REDIS_STREAM_MAX_DECOMPRESSED_BYTES),
      10,
    ),
    brotliQuality: Number.parseInt(
      process.env["REDIS_STREAM_PAYLOAD_BROTLI_QUALITY"] || "1",
      10,
    ),
    decodeCacheMaxBytes: Number.parseInt(
      process.env["REDIS_STREAM_PAYLOAD_DECODE_CACHE_MAX_BYTES"] ||
        String(DEFAULT_REDIS_STREAM_DECODE_CACHE_MAX_BYTES),
      10,
    ),
  });
}
