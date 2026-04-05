import type { AttachmentMediaResolver, ResolvedAttachmentMedia } from "./AttachmentMediaResolver.js";
import type { BridgePostMediaStore } from "../../../protocol-bridge/post/BridgePostMedia.js";

export interface StoredAttachmentMediaResolverLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export class StoredAttachmentMediaResolver implements AttachmentMediaResolver {
  public constructor(
    private readonly store: BridgePostMediaStore,
    private readonly logger?: StoredAttachmentMediaResolverLogger,
  ) {}

  public async resolveMedia(did: string, mediaId: string): Promise<ResolvedAttachmentMedia | null> {
    const descriptor = await this.store.get(mediaId);
    if (!descriptor) {
      return null;
    }

    if (descriptor.ownerDid !== did) {
      this.logger?.warn("Post media descriptor owner DID mismatch detected during native attachment resolution", {
        requestedDid: did,
        descriptorDid: descriptor.ownerDid,
        mediaId,
        canonicalPostId: descriptor.canonicalPostId,
      });
      return null;
    }

    return {
      mimeType: descriptor.blob.mimeType,
      blobRef: descriptor.blob,
    };
  }
}
