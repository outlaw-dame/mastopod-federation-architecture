import { constants, brotliCompressSync, brotliDecompressSync } from "node:zlib";

export const REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX = "apq1:br:";
export const REDIS_STREAM_PAYLOAD_UNKNOWN_PREFIX = "apq1:";
export const DEFAULT_REDIS_STREAM_COMPRESSION_MIN_BYTES = 4 * 1024;
export const DEFAULT_REDIS_STREAM_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_REDIS_STREAM_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

export interface RedisStreamPayloadCodecConfig {
  writeEnabled?: boolean;
  minBytes?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  brotliQuality?: number;
}

export interface EncodedRedisStreamPayload {
  value: string;
  compressed: boolean;
  sourceBytes: number;
  storedBytes: number;
}

function finitePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function boundedBrotliQuality(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 4;
  return Math.max(0, Math.min(11, Math.floor(value)));
}

export class RedisStreamPayloadCodec {
  private readonly writeEnabled: boolean;
  private readonly minBytes: number;
  private readonly maxCompressedBytes: number;
  private readonly maxDecompressedBytes: number;
  private readonly brotliQuality: number;

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
  }

  encode(value: string): EncodedRedisStreamPayload {
    const sourceBytes = Buffer.byteLength(value);
    if (!this.writeEnabled || sourceBytes < this.minBytes) {
      return { value, compressed: false, sourceBytes, storedBytes: sourceBytes };
    }
    if (sourceBytes > this.maxDecompressedBytes) {
      throw new Error(
        `Redis Stream payload exceeds maximum uncompressed size of ${this.maxDecompressedBytes} bytes`,
      );
    }

    const compressed = brotliCompressSync(Buffer.from(value), {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: this.brotliQuality,
      },
    });
    if (compressed.byteLength > this.maxCompressedBytes) {
      throw new Error(
        `Redis Stream compressed payload exceeds maximum size of ${this.maxCompressedBytes} bytes`,
      );
    }

    const encoded = `${REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX}${compressed.toString("base64url")}`;
    const storedBytes = Buffer.byteLength(encoded);

    // Compression is an optimization, not an obligation. Keep plaintext when
    // the self-describing JSON-safe envelope is not actually smaller.
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

    const encoded = value.slice(REDIS_STREAM_PAYLOAD_ENVELOPE_PREFIX.length);
    if (!encoded) {
      throw new Error("Redis Stream Brotli payload is empty");
    }

    let compressed: Buffer;
    try {
      compressed = Buffer.from(encoded, "base64url");
    } catch {
      throw new Error("Redis Stream Brotli payload is not valid base64url");
    }
    if (compressed.byteLength === 0) {
      throw new Error("Redis Stream Brotli payload decoded to zero bytes");
    }
    if (compressed.byteLength > this.maxCompressedBytes) {
      throw new Error(
        `Redis Stream compressed payload exceeds maximum size of ${this.maxCompressedBytes} bytes`,
      );
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
    return decompressed.toString("utf8");
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
      process.env["REDIS_STREAM_PAYLOAD_BROTLI_QUALITY"] || "4",
      10,
    ),
  });
}
