import * as zlib from "node:zlib";
import {
  CompressionCodecs,
  CompressionTypes,
  type CompressionTypes as CompressionType,
} from "kafkajs";

export type RedpandaCompressionName = "none" | "gzip" | "zstd";

const ZSTD_MIN_NODE = { major: 22, minor: 15 } as const;
const DEFAULT_ZSTD_LEVEL = 1;
const MIN_ZSTD_LEVEL = -131072;
const MAX_ZSTD_LEVEL = 22;

type EncoderLike = { buffer: Buffer };
type KafkaCodec = {
  compress(encoder: EncoderLike): Promise<Buffer>;
  decompress(buffer: Buffer): Promise<Buffer>;
};

type ZstdCallback = (error: Error | null, result: Buffer) => void;
type ZstdCapableZlib = typeof zlib & {
  zstdCompress?: (buffer: Buffer, options: Record<string, unknown>, callback: ZstdCallback) => void;
  zstdDecompress?: (buffer: Buffer, options: Record<string, unknown>, callback: ZstdCallback) => void;
};

function parseNodeVersion(version = process.versions.node): { major: number; minor: number } {
  const [majorRaw, minorRaw] = version.split(".");
  return {
    major: Number.parseInt(majorRaw ?? "0", 10),
    minor: Number.parseInt(minorRaw ?? "0", 10),
  };
}

export function hasNativeZstdSupport(version = process.versions.node): boolean {
  const { major, minor } = parseNodeVersion(version);
  if (major > ZSTD_MIN_NODE.major) return true;
  if (major < ZSTD_MIN_NODE.major) return false;
  return minor >= ZSTD_MIN_NODE.minor;
}

export function parseZstdLevel(raw = process.env["REDPANDA_ZSTD_LEVEL"]): number {
  if (raw === undefined || raw === "") return DEFAULT_ZSTD_LEVEL;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`REDPANDA_ZSTD_LEVEL must be an integer, got ${raw}`);
  }
  const level = Number(raw);
  if (!Number.isSafeInteger(level) || level < MIN_ZSTD_LEVEL || level > MAX_ZSTD_LEVEL) {
    throw new Error(
      `REDPANDA_ZSTD_LEVEL must be between ${MIN_ZSTD_LEVEL} and ${MAX_ZSTD_LEVEL}, got ${raw}`,
    );
  }
  return level;
}

function zstdOptions(level: number): Record<string, unknown> {
  const compressionLevelConstant = (zlib.constants as unknown as Record<string, number>)[
    "ZSTD_c_compressionLevel"
  ];
  if (compressionLevelConstant === undefined) {
    throw new Error("Node.js runtime does not expose the Zstd compression-level constant");
  }
  return { params: { [compressionLevelConstant]: level } };
}

function registerNativeZstdCodec(level: number): void {
  if (!hasNativeZstdSupport()) {
    throw new Error(
      `REDPANDA_COMPRESSION=zstd requires Node.js >= ${ZSTD_MIN_NODE.major}.${ZSTD_MIN_NODE.minor}; current runtime is ${process.versions.node}`,
    );
  }

  const native = zlib as ZstdCapableZlib;
  if (typeof native.zstdCompress !== "function" || typeof native.zstdDecompress !== "function") {
    throw new Error(
      `REDPANDA_COMPRESSION=zstd was requested but this Node.js ${process.versions.node} build has no native Zstd support`,
    );
  }

  const options = zstdOptions(level);
  const compress = native.zstdCompress.bind(native);
  const decompress = native.zstdDecompress.bind(native);

  CompressionCodecs[CompressionTypes.ZSTD] = () =>
    ({
      compress: async (encoder: EncoderLike): Promise<Buffer> =>
        await new Promise<Buffer>((resolve, reject) => {
          compress(encoder.buffer, options, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        }),
      decompress: async (buffer: Buffer): Promise<Buffer> =>
        await new Promise<Buffer>((resolve, reject) => {
          decompress(buffer, {}, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        }),
    }) satisfies KafkaCodec;
}

export function resolveRedpandaCompression(
  raw = process.env["REDPANDA_COMPRESSION"] ?? "zstd",
): { name: RedpandaCompressionName; type: CompressionType; zstdLevel?: number } {
  const name = raw.trim().toLowerCase();
  switch (name) {
    case "none":
      return { name, type: CompressionTypes.None };
    case "gzip":
      return { name, type: CompressionTypes.GZIP };
    case "zstd": {
      const zstdLevel = parseZstdLevel();
      registerNativeZstdCodec(zstdLevel);
      return { name, type: CompressionTypes.ZSTD, zstdLevel };
    }
    case "snappy":
    case "lz4":
      throw new Error(
        `REDPANDA_COMPRESSION=${name} is supported by Redpanda but not bundled by KafkaJS; use zstd (preferred), gzip, or none instead of failing later during produce/consume`,
      );
    default:
      throw new Error(
        `Unsupported REDPANDA_COMPRESSION=${raw}; expected zstd, gzip, or none`,
      );
  }
}

export function ensureRedpandaCompressionCodec(
  raw = process.env["REDPANDA_COMPRESSION"] ?? "zstd",
): CompressionType {
  return resolveRedpandaCompression(raw).type;
}
