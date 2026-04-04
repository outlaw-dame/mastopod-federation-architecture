export interface CanonicalAsset {
  assetId: string; // sha256 or derived id
  ownerId: string; // actorUri or DID

  // storage
  sha256: string;
  cid?: string;
  filebaseKey: string;

  // URLs
  canonicalUrl: string;
  gatewayUrl?: string;

  // metadata
  mimeType: string;
  kind: 'attachment' | 'avatar' | 'banner' | 'video';
  width?: number;
  height?: number;
  size: number;

  // derived
  variants: AssetVariant[];
  blurhash?: string;
  alt?: string;

  // moderation
  moderation?: {
    status?: 'ok' | 'flagged' | 'blocked';
    labels?: string[];
  };

  // timestamps
  createdAt: string;
  updatedAt?: string;
}

export interface AssetVariant {
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  size: number;
  label: 'original' | 'thumbnail' | 'small' | 'medium' | 'large';
}
