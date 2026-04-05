import { createHash } from "node:crypto";
import type {
  CanonicalAttachment,
  CanonicalAttachmentRole,
} from "../canonical/CanonicalContent.js";

export interface BridgeProfileMediaDraft {
  mediaId: string;
  role: CanonicalAttachmentRole;
  sourceUrl: string;
  mimeType: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface BridgeProfileMediaDescriptor extends BridgeProfileMediaDraft {
  ownerDid: string;
  createdAt: string;
}

export interface BridgeProfileMediaStore {
  put(descriptor: BridgeProfileMediaDescriptor): Promise<void>;
  get(mediaId: string): Promise<BridgeProfileMediaDescriptor | null>;
  delete(mediaId: string): Promise<void>;
}

export class InMemoryBridgeProfileMediaStore implements BridgeProfileMediaStore {
  private readonly descriptors = new Map<string, BridgeProfileMediaDescriptor>();

  public async put(descriptor: BridgeProfileMediaDescriptor): Promise<void> {
    this.descriptors.set(descriptor.mediaId, { ...descriptor });
  }

  public async get(mediaId: string): Promise<BridgeProfileMediaDescriptor | null> {
    const descriptor = this.descriptors.get(mediaId);
    return descriptor ? { ...descriptor } : null;
  }

  public async delete(mediaId: string): Promise<void> {
    this.descriptors.delete(mediaId);
  }
}

export interface RedisBridgeProfileMediaStoreOptions {
  keyPrefix?: string;
  ttlSeconds?: number;
}

type RedisLike = {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
};

export class RedisBridgeProfileMediaStore implements BridgeProfileMediaStore {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  public constructor(
    private readonly redis: RedisLike,
    options: RedisBridgeProfileMediaStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "protocol-bridge:profile-media";
    this.ttlSeconds = Number.isFinite(options.ttlSeconds)
      ? Math.max(60, Math.trunc(options.ttlSeconds!))
      : 60 * 60 * 24;
  }

  public async put(descriptor: BridgeProfileMediaDescriptor): Promise<void> {
    await this.redis.set(
      this.buildKey(descriptor.mediaId),
      JSON.stringify(descriptor),
      "EX",
      this.ttlSeconds,
    );
  }

  public async get(mediaId: string): Promise<BridgeProfileMediaDescriptor | null> {
    const raw = await this.redis.get(this.buildKey(mediaId));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<BridgeProfileMediaDescriptor>;
      if (
        typeof parsed.mediaId !== "string" ||
        typeof parsed.ownerDid !== "string" ||
        typeof parsed.sourceUrl !== "string" ||
        typeof parsed.mimeType !== "string" ||
        (parsed.role !== "avatar" && parsed.role !== "banner")
      ) {
        return null;
      }

      return {
        mediaId: parsed.mediaId,
        ownerDid: parsed.ownerDid,
        role: parsed.role,
        sourceUrl: parsed.sourceUrl,
        mimeType: parsed.mimeType,
        alt: typeof parsed.alt === "string" ? parsed.alt : null,
        width: typeof parsed.width === "number" && Number.isFinite(parsed.width) ? parsed.width : null,
        height: typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : null,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  public async delete(mediaId: string): Promise<void> {
    await this.redis.del(this.buildKey(mediaId));
  }

  private buildKey(mediaId: string): string {
    return `${this.keyPrefix}:${mediaId}`;
  }
}

export function pickProfileAttachment(
  attachments: readonly CanonicalAttachment[],
  role: CanonicalAttachmentRole,
): CanonicalAttachment | null {
  return attachments.find((attachment) => attachment.role === role) ?? null;
}

export function buildProfileMediaDraft(
  ownerStableId: string,
  role: CanonicalAttachmentRole,
  attachment: CanonicalAttachment | null,
): BridgeProfileMediaDraft | null {
  if (!attachment?.url) {
    return null;
  }

  const mimeType = normalizeProfileImageMimeType(attachment.mediaType);
  if (!mimeType) {
    return null;
  }

  return {
    mediaId: deriveBridgeProfileMediaId(ownerStableId, role, attachment),
    role,
    sourceUrl: attachment.url,
    mimeType,
    alt: attachment.alt ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
  };
}

export function deriveBridgeProfileMediaId(
  ownerStableId: string,
  role: CanonicalAttachmentRole,
  attachment: Pick<CanonicalAttachment, "attachmentId" | "url" | "cid">,
): string {
  return createHash("sha256")
    .update(ownerStableId)
    .update(":")
    .update(role)
    .update(":")
    .update(attachment.cid ?? "")
    .update(":")
    .update(attachment.url ?? "")
    .update(":")
    .update(attachment.attachmentId)
    .digest("hex")
    .slice(0, 32);
}

export function normalizeProfileImageMimeType(mediaType: string | null | undefined): string | null {
  const normalized = typeof mediaType === "string" ? mediaType.trim().toLowerCase() : "";
  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/png":
    case "image/gif":
    case "image/webp":
      return normalized;
    case "image/*":
      return "image/jpeg";
    default:
      return null;
  }
}
