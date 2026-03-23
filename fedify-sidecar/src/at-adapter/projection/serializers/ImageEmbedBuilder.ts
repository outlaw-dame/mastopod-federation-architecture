/**
 * V6.5 Phase 5: Image Embed Builder
 *
 * Builds app.bsky.embed.images from canonical post attachments.
 */

import { CanonicalPost } from '../AtProjectionPolicy';
import { AtBlobRef } from '../../blob/AtBlobStore';
import { AtBlobUploadService } from '../../blob/AtBlobUploadService';

export interface AppBskyEmbedImages {
  $type: 'app.bsky.embed.images';
  images: Array<{
    alt: string;
    image: AtBlobRef;
    aspectRatio?: {
      width: number;
      height: number;
    };
  }>;
}

export interface ImageEmbedBuilder {
  build(post: CanonicalPost, did: string): Promise<AppBskyEmbedImages | undefined>;
}

export class DefaultImageEmbedBuilder implements ImageEmbedBuilder {
  constructor(
    private readonly blobUploadService: AtBlobUploadService,
    private readonly mediaResolver: any // Mocked dependency to fetch bytes
  ) {}

  async build(post: CanonicalPost, did: string): Promise<AppBskyEmbedImages | undefined> {
    // 1. Filter attachments (images only)
    const attachments = post.attachments || [];
    const imageAttachments = attachments.filter(a => a.kind === 'image');

    if (imageAttachments.length === 0) {
      return undefined;
    }

    // 2. Cap at 4 images
    const cappedAttachments = imageAttachments.slice(0, 4);

    const images = [];

    // 3. Process each image
    for (const attachment of cappedAttachments) {
      try {
        // Fetch bytes + mime
        const media = await this.mediaResolver.resolveMedia(attachment.mediaId);
        if (!media) continue;

        // Upload/store via AtBlobUploadService
        const blobRef = await this.blobUploadService.ensureImageBlob({
          did,
          mediaId: attachment.mediaId,
          mimeType: media.mimeType,
          bytes: media.bytes
        });

        // Map alt text and aspect ratio
        images.push({
          alt: attachment.altText || '',
          image: blobRef,
          ...(attachment.width && attachment.height ? {
            aspectRatio: {
              width: attachment.width,
              height: attachment.height
            }
          } : {})
        });
      } catch (error) {
        console.error(`Failed to process image attachment ${attachment.mediaId}:`, error);
        // Continue with other images even if one fails
      }
    }

    if (images.length === 0) {
      return undefined;
    }

    // 4. Return app.bsky.embed.images
    return {
      $type: 'app.bsky.embed.images',
      images
    };
  }
}
