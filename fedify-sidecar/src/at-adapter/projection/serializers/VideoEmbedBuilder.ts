import { CanonicalPost } from "../AtProjectionPolicy.js";
import { AtBlobRef } from "../../blob/AtBlobStore.js";
import { AtBlobUploadService } from "../../blob/AtBlobUploadService.js";
import type { AttachmentMediaResolver } from "./AttachmentMediaResolver.js";

export interface AppBskyEmbedVideo {
  $type: "app.bsky.embed.video";
  video: AtBlobRef;
  alt?: string;
  aspectRatio?: {
    width: number;
    height: number;
  };
}

export interface VideoEmbedBuilder {
  build(post: CanonicalPost, did: string): Promise<AppBskyEmbedVideo | undefined>;
}

export class DefaultVideoEmbedBuilder implements VideoEmbedBuilder {
  public constructor(
    private readonly blobUploadService: AtBlobUploadService,
    private readonly mediaResolver: AttachmentMediaResolver,
  ) {}

  public async build(
    post: CanonicalPost,
    did: string,
  ): Promise<AppBskyEmbedVideo | undefined> {
    const attachment = (post.attachments || []).find((candidate) => candidate.kind === "video");
    if (!attachment) {
      return undefined;
    }

    try {
      const media = await this.mediaResolver.resolveMedia(did, attachment.mediaId);
      if (!media || !media.mimeType.startsWith("video/")) {
        return undefined;
      }

      const video = media.blobRef
        ? media.blobRef
        : media.bytes
          ? await this.blobUploadService.ensureBlob({
              did,
              mediaId: attachment.mediaId,
              mimeType: media.mimeType,
              bytes: media.bytes,
            })
          : null;
      if (!video) {
        return undefined;
      }

      const embed: AppBskyEmbedVideo = {
        $type: "app.bsky.embed.video",
        video,
      };

      if (attachment.altText) {
        embed.alt = attachment.altText;
      }

      if (isFiniteDimension(attachment.width) && isFiniteDimension(attachment.height)) {
        embed.aspectRatio = {
          width: attachment.width,
          height: attachment.height,
        };
      }

      return embed;
    } catch (error) {
      console.error(`Failed to process video attachment ${attachment.mediaId}:`, error);
      return undefined;
    }
  }
}

function isFiniteDimension(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
