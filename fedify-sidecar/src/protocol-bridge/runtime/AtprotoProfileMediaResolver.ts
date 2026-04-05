import type { AtBlobUploadService } from "../../at-adapter/blob/AtBlobUploadService.js";
import type { ProfileMediaResolver } from "../../at-adapter/projection/serializers/ProfileRecordSerializer.js";
import type { BridgeProfileMediaStore } from "../profile/BridgeProfileMedia.js";
import { ActivityPubBridgeProfileMediaClient } from "./ActivityPubBridgeProfileMediaClient.js";

export interface AtprotoProfileMediaResolverLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class AtprotoProfileMediaResolver implements ProfileMediaResolver {
  public constructor(
    private readonly mediaStore: BridgeProfileMediaStore,
    private readonly mediaClient: ActivityPubBridgeProfileMediaClient,
    private readonly blobUploadService: AtBlobUploadService,
    private readonly logger?: AtprotoProfileMediaResolverLogger,
  ) {}

  public async resolveAvatarBlob(mediaId: string): Promise<unknown | null> {
    return this.resolveBlob(mediaId, "avatar");
  }

  public async resolveBannerBlob(mediaId: string): Promise<unknown | null> {
    return this.resolveBlob(mediaId, "banner");
  }

  private async resolveBlob(
    mediaId: string,
    expectedRole: "avatar" | "banner",
  ): Promise<unknown | null> {
    const descriptor = await this.mediaStore.get(mediaId);
    if (!descriptor) {
      this.logger?.warn("Protocol bridge profile media descriptor was missing at serialization time", {
        mediaId,
        expectedRole,
      });
      return null;
    }

    if (descriptor.role !== expectedRole) {
      this.logger?.warn("Protocol bridge profile media role mismatch detected", {
        mediaId,
        expectedRole,
        actualRole: descriptor.role,
      });
      return null;
    }

    const resolved = await this.mediaClient.resolve(descriptor.sourceUrl);
    if (!resolved) {
      this.logger?.warn("Protocol bridge profile media could not be resolved and will be omitted", {
        mediaId,
        expectedRole,
        sourceUrl: descriptor.sourceUrl,
      });
      return null;
    }

    return this.blobUploadService.ensureImageBlob({
      did: descriptor.ownerDid,
      mediaId: descriptor.mediaId,
      mimeType: resolved.mimeType,
      bytes: resolved.bytes,
    });
  }
}
