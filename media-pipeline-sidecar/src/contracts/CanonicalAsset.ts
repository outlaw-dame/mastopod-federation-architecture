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
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  canonicalUrl: string;
  gatewayUrl?: string;
  variants: AssetVariant;
  alt?: string;
  contentWarning?: string;
  isSensitive?: boolean;
  createdAt: string;
}
