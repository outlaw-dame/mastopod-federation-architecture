export interface VideoPlaybackVariant {
  label: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  bitrateKbps?: number;
}

export interface VideoStreamingVariant {
  label: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  bitrateKbps?: number;
}

export interface VideoStreamingManifest {
  protocol: 'hls' | 'dash';
  url: string;
  mimeType: string;
  defaultVariantLabel?: string;
  variants: VideoStreamingVariant[];
}

export interface AssetVariant {
  original: string;
  thumbnail?: string;
  preview?: string;
  playback?: VideoPlaybackVariant[];
  streaming?: VideoStreamingManifest[];
}

export interface CanonicalAsset {
  assetId: string;
  ownerId: string;
  ownerIds?: string[];
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
  sourceUrls?: string[];
  variants: AssetVariant;
  alt?: string;
  blurhash?: string;
  contentWarning?: string;
  isSensitive?: boolean;
  createdAt: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  ingestCount?: number;
}
