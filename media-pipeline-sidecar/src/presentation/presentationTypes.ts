export interface MediaPresentationMetadata {
  altText: string;
  contentWarning?: string;
  isSensitive: boolean;
  hideMediaByDefault: boolean;
  blurPreviewUrl?: string;
  blurhash?: string;
}

export interface PostPresentationMetadata {
  contentWarning?: string;
  isSensitive: boolean;
  labels?: string[];
}
