import { MediaPresentationMetadata } from './presentationTypes.js';

export function mapModerationToPresentation(params: {
  moderation?: {
    labels?: string[];
    status?: 'ok' | 'flagged' | 'blocked';
  };
  blurhash?: string;
  alt?: string;
}): MediaPresentationMetadata {
  const labels = params.moderation?.labels || [];

  const isSensitive = labels.includes('nsfw') || labels.includes('graphic-media');

  let contentWarning: string | undefined;

  if (labels.includes('graphic-media')) {
    contentWarning = 'Graphic content';
  } else if (labels.includes('nsfw')) {
    contentWarning = 'Sensitive content';
  }

  return {
    altText: params.alt || '',
    contentWarning,
    isSensitive,
    hideMediaByDefault: isSensitive,
    blurhash: params.blurhash
  };
}
