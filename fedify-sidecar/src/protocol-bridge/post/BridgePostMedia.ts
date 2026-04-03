import { createHash } from "node:crypto";
import type { AtBlobRef } from "../../at-adapter/blob/AtBlobStore.js";

export type BridgePostMediaKind = "image" | "video" | "audio" | "document";

export interface BridgePostMediaDraft {
  mediaId: string;
  canonicalPostId: string;
  kind: BridgePostMediaKind;
  blob: AtBlobRef;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface BridgePostMediaDescriptor extends BridgePostMediaDraft {
  ownerDid: string;
  createdAt: string;
}

export interface BridgePostMediaStore {
  put(descriptor: BridgePostMediaDescriptor): Promise<void>;
  get(mediaId: string): Promise<BridgePostMediaDescriptor | null>;
  delete(mediaId: string): Promise<void>;
  listByCanonicalPostId(canonicalPostId: string): Promise<BridgePostMediaDescriptor[]>;
}

export class InMemoryBridgePostMediaStore implements BridgePostMediaStore {
  private readonly descriptors = new Map<string, BridgePostMediaDescriptor>();
  private readonly mediaIdsByPostId = new Map<string, Set<string>>();

  public async put(descriptor: BridgePostMediaDescriptor): Promise<void> {
    const existing = this.descriptors.get(descriptor.mediaId);
    if (existing && existing.canonicalPostId !== descriptor.canonicalPostId) {
      this.removeIndex(existing.canonicalPostId, existing.mediaId);
    }
    this.descriptors.set(descriptor.mediaId, { ...descriptor, blob: cloneBlobRef(descriptor.blob) });
    this.addIndex(descriptor.canonicalPostId, descriptor.mediaId);
  }

  public async get(mediaId: string): Promise<BridgePostMediaDescriptor | null> {
    const descriptor = this.descriptors.get(mediaId);
    return descriptor ? { ...descriptor, blob: cloneBlobRef(descriptor.blob) } : null;
  }

  public async delete(mediaId: string): Promise<void> {
    const descriptor = this.descriptors.get(mediaId);
    this.descriptors.delete(mediaId);
    if (descriptor) {
      this.removeIndex(descriptor.canonicalPostId, mediaId);
    }
  }

  public async listByCanonicalPostId(canonicalPostId: string): Promise<BridgePostMediaDescriptor[]> {
    const mediaIds = this.mediaIdsByPostId.get(canonicalPostId);
    if (!mediaIds || mediaIds.size === 0) {
      return [];
    }

    return Array.from(mediaIds)
      .map((mediaId) => this.descriptors.get(mediaId))
      .filter((descriptor): descriptor is BridgePostMediaDescriptor => !!descriptor)
      .map((descriptor) => ({ ...descriptor, blob: cloneBlobRef(descriptor.blob) }));
  }

  private addIndex(canonicalPostId: string, mediaId: string): void {
    const mediaIds = this.mediaIdsByPostId.get(canonicalPostId) ?? new Set<string>();
    mediaIds.add(mediaId);
    this.mediaIdsByPostId.set(canonicalPostId, mediaIds);
  }

  private removeIndex(canonicalPostId: string, mediaId: string): void {
    const mediaIds = this.mediaIdsByPostId.get(canonicalPostId);
    if (!mediaIds) {
      return;
    }
    mediaIds.delete(mediaId);
    if (mediaIds.size === 0) {
      this.mediaIdsByPostId.delete(canonicalPostId);
    }
  }
}

export interface RedisBridgePostMediaStoreOptions {
  keyPrefix?: string;
  ttlSeconds?: number;
}

type RedisLike = {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
};

export class RedisBridgePostMediaStore implements BridgePostMediaStore {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  public constructor(
    private readonly redis: RedisLike,
    options: RedisBridgePostMediaStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "protocol-bridge:post-media";
    this.ttlSeconds = Number.isFinite(options.ttlSeconds)
      ? Math.max(60, Math.trunc(options.ttlSeconds!))
      : 60 * 60 * 24;
  }

  public async put(descriptor: BridgePostMediaDescriptor): Promise<void> {
    const existing = await this.get(descriptor.mediaId);
    await this.redis.set(
      this.buildKey(descriptor.mediaId),
      JSON.stringify(descriptor),
      "EX",
      this.ttlSeconds,
    );
    if (existing && existing.canonicalPostId !== descriptor.canonicalPostId) {
      await this.removeFromPostIndex(existing.canonicalPostId, existing.mediaId);
    }
    await this.addToPostIndex(descriptor.canonicalPostId, descriptor.mediaId);
  }

  public async get(mediaId: string): Promise<BridgePostMediaDescriptor | null> {
    const raw = await this.redis.get(this.buildKey(mediaId));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<BridgePostMediaDescriptor>;
      if (
        typeof parsed.mediaId !== "string" ||
        typeof parsed.ownerDid !== "string" ||
        typeof parsed.canonicalPostId !== "string" ||
        !isBridgePostMediaKind(parsed.kind) ||
        !isBlobRef(parsed.blob)
      ) {
        return null;
      }

      return {
        mediaId: parsed.mediaId,
        ownerDid: parsed.ownerDid,
        canonicalPostId: parsed.canonicalPostId,
        kind: parsed.kind,
        blob: cloneBlobRef(parsed.blob),
        alt: typeof parsed.alt === "string" ? parsed.alt : null,
        width: toFiniteDimension(parsed.width),
        height: toFiniteDimension(parsed.height),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  public async delete(mediaId: string): Promise<void> {
    const existing = await this.get(mediaId);
    await this.redis.del(this.buildKey(mediaId));
    if (existing) {
      await this.removeFromPostIndex(existing.canonicalPostId, mediaId);
    }
  }

  public async listByCanonicalPostId(canonicalPostId: string): Promise<BridgePostMediaDescriptor[]> {
    const mediaIds = await this.readPostIndex(canonicalPostId);
    if (mediaIds.length === 0) {
      return [];
    }

    const descriptors = await Promise.all(mediaIds.map(async (mediaId) => this.get(mediaId)));
    return descriptors.filter((descriptor): descriptor is BridgePostMediaDescriptor =>
      !!descriptor && descriptor.canonicalPostId === canonicalPostId,
    );
  }

  private buildKey(mediaId: string): string {
    return `${this.keyPrefix}:${mediaId}`;
  }

  private buildPostIndexKey(canonicalPostId: string): string {
    return `${this.keyPrefix}:post:${canonicalPostId}`;
  }

  private async addToPostIndex(canonicalPostId: string, mediaId: string): Promise<void> {
    const mediaIds = await this.readPostIndex(canonicalPostId);
    if (!mediaIds.includes(mediaId)) {
      mediaIds.push(mediaId);
      await this.writePostIndex(canonicalPostId, mediaIds);
    }
  }

  private async removeFromPostIndex(canonicalPostId: string, mediaId: string): Promise<void> {
    const mediaIds = await this.readPostIndex(canonicalPostId);
    const nextIds = mediaIds.filter((candidate) => candidate !== mediaId);
    if (nextIds.length === 0) {
      await this.redis.del(this.buildPostIndexKey(canonicalPostId));
      return;
    }
    await this.writePostIndex(canonicalPostId, nextIds);
  }

  private async readPostIndex(canonicalPostId: string): Promise<string[]> {
    const raw = await this.redis.get(this.buildPostIndexKey(canonicalPostId));
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      return [];
    }
  }

  private async writePostIndex(canonicalPostId: string, mediaIds: string[]): Promise<void> {
    await this.redis.set(
      this.buildPostIndexKey(canonicalPostId),
      JSON.stringify(Array.from(new Set(mediaIds))),
      "EX",
      this.ttlSeconds,
    );
  }
}

export function buildPostMediaDraftsFromRecord(
  canonicalPostId: string,
  record: Record<string, unknown>,
): BridgePostMediaDraft[] {
  return extractMediaDrafts(canonicalPostId, toPlainObject(record["embed"]));
}

export function deriveBridgePostMediaId(
  canonicalPostId: string,
  kind: BridgePostMediaKind,
  blobCid: string,
  slot: number,
): string {
  return createHash("sha256")
    .update(canonicalPostId)
    .update(":")
    .update(kind)
    .update(":")
    .update(blobCid)
    .update(":")
    .update(String(slot))
    .digest("hex")
    .slice(0, 32);
}

function extractMediaDrafts(
  canonicalPostId: string,
  embed: Record<string, unknown> | null,
): BridgePostMediaDraft[] {
  if (!embed) {
    return [];
  }

  const embedType = typeof embed["$type"] === "string" ? embed["$type"] : "";
  if (embedType === "app.bsky.embed.images") {
    const images = Array.isArray(embed["images"]) ? embed["images"] : [];
    return images.flatMap((entry, index) => {
      const image = toPlainObject(entry);
      const blob = isBlobRef(image?.["image"]) ? image["image"] : null;
      if (!blob) {
        return [];
      }
      return [{
        mediaId: deriveBridgePostMediaId(canonicalPostId, "image", blob.ref.$link, index),
        canonicalPostId,
        kind: "image" as const,
        blob: cloneBlobRef(blob),
        alt: typeof image?.["alt"] === "string" ? image["alt"] : null,
        width: toFiniteDimension(toPlainObject(image?.["aspectRatio"])?.["width"]),
        height: toFiniteDimension(toPlainObject(image?.["aspectRatio"])?.["height"]),
      }];
    });
  }

  if (embedType === "app.bsky.embed.video") {
    const blob = isBlobRef(embed["video"]) ? embed["video"] : null;
    if (!blob) {
      return [];
    }

    return [{
      mediaId: deriveBridgePostMediaId(canonicalPostId, "video", blob.ref.$link, 0),
      canonicalPostId,
      kind: "video",
      blob: cloneBlobRef(blob),
      alt: typeof embed["alt"] === "string" ? embed["alt"] : null,
      width: toFiniteDimension(toPlainObject(embed["aspectRatio"])?.["width"]),
      height: toFiniteDimension(toPlainObject(embed["aspectRatio"])?.["height"]),
    }];
  }

  if (embedType === "app.bsky.embed.recordWithMedia") {
    return extractMediaDrafts(canonicalPostId, toPlainObject(embed["media"]));
  }

  return [];
}

function isBridgePostMediaKind(value: unknown): value is BridgePostMediaKind {
  return value === "image" || value === "video" || value === "audio" || value === "document";
}

function isBlobRef(value: unknown): value is AtBlobRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<AtBlobRef>;
  return candidate.$type === "blob"
    && !!candidate.ref
    && typeof candidate.ref.$link === "string"
    && typeof candidate.mimeType === "string"
    && typeof candidate.size === "number"
    && Number.isFinite(candidate.size);
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toFiniteDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function cloneBlobRef(blob: AtBlobRef): AtBlobRef {
  return {
    $type: "blob",
    ref: { $link: blob.ref.$link },
    mimeType: blob.mimeType,
    size: blob.size,
  };
}
