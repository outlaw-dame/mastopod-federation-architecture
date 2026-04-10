export interface AssetVariant {
  original: string;
  thumbnail?: string;
  preview?: string;
}

export interface CanonicalAsset {
  assetId: string;
  ownerId: string;
  sha256: string;
  cid?: string;
  digestMultibase?: string;
  mimeType: string;
  size: number;
  duration?: string | number;
  width?: number;
  height?: number;
  focalPoint?: [number, number];
  canonicalUrl: string;
  gatewayUrl?: string;
  variants: AssetVariant;
  alt?: string;
  blurhash?: string;
  contentWarning?: string;
  isSensitive?: boolean;
  createdAt: string;
}
