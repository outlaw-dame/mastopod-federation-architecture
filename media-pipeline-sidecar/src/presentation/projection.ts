import { MediaPresentationMetadata } from './presentationTypes.js';

export function buildActivityPubAttachment(params: {
  url: string;
  mimeType: string;
  alt?: string;
  blurhash?: string;
  sensitive?: boolean;
}) {
  return {
    type: 'Image',
    mediaType: params.mimeType,
    url: params.url,
    summary: params.alt,
    blurhash: params.blurhash,
    sensitive: params.sensitive
  };
}

export function buildActivityPubPostMeta(params: {
  content: string;
  contentWarning?: string;
  sensitive?: boolean;
}) {
  return {
    content: params.content,
    summary: params.contentWarning,
    sensitive: params.sensitive
  };
}

export function buildATProtoImageEmbed(params: {
  blobRef: any;
  alt: string;
  width?: number;
  height?: number;
}) {
  return {
    $type: 'app.bsky.embed.images',
    images: [
      {
        alt: params.alt,
        image: params.blobRef,
        aspectRatio: params.width && params.height
          ? { width: params.width, height: params.height }
          : undefined
      }
    ]
  };
}

export function buildATProtoLabels(labels: string[]) {
  return labels.map((val) => ({ val }));
}
