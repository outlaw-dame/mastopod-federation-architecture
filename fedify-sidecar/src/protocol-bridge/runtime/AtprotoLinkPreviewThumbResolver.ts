import { createHash } from "node:crypto";
import type { AtBlobUploadService } from "../../at-adapter/blob/AtBlobUploadService.js";
import { ActivityPubBridgeProfileMediaClient } from "./ActivityPubBridgeProfileMediaClient.js";

export interface AtprotoLinkPreviewThumbResolverLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class AtprotoLinkPreviewThumbResolver {
  public constructor(
    private readonly mediaClient: ActivityPubBridgeProfileMediaClient,
    private readonly blobUploadService: AtBlobUploadService,
    private readonly logger?: AtprotoLinkPreviewThumbResolverLogger,
  ) {}

  public async resolveThumbBlob(
    did: string,
    thumbUrl: string,
    scope: {
      canonicalIntentId?: string | null;
      canonicalRefIdHint?: string | null;
      externalUri?: string | null;
    } = {},
  ): Promise<unknown | null> {
    const media = await this.mediaClient.resolve(thumbUrl);
    if (!media) {
      this.logger?.warn("Protocol bridge link preview thumbnail could not be resolved and will be omitted", {
        did,
        thumbUrl,
        externalUri: scope.externalUri ?? null,
        canonicalIntentId: scope.canonicalIntentId ?? null,
        canonicalRefIdHint: scope.canonicalRefIdHint ?? null,
      });
      return null;
    }

    return this.blobUploadService.ensureImageBlob({
      did,
      mediaId: buildLinkPreviewMediaId(thumbUrl, scope),
      mimeType: media.mimeType,
      bytes: media.bytes,
    });
  }
}

function buildLinkPreviewMediaId(
  thumbUrl: string,
  scope: {
    canonicalIntentId?: string | null;
    canonicalRefIdHint?: string | null;
    externalUri?: string | null;
  },
): string {
  return createHash("sha256")
    .update([
      scope.canonicalIntentId?.trim() || "",
      scope.canonicalRefIdHint?.trim() || "",
      scope.externalUri?.trim() || "",
      thumbUrl.trim(),
    ].join("\n"))
    .digest("hex")
    .slice(0, 32);
}
