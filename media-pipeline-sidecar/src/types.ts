export interface MediaResolveRequest {
  mediaUrl: string;
  maxBytes?: number;
  kind?: 'attachment' | 'profile';
}

export interface MediaResolveResponse {
  mediaUrl: string;
  mimeType: string;
  bytesBase64: string;
  size: number;
  resolvedAt: string;
}

export interface MediaIngestRequest {
  actorUri: string;
  objectId?: string;
  mimeType?: string;
  filename?: string;
  bytesBase64?: string;
  sourceUrl?: string;
  kind: 'attachment' | 'avatar' | 'banner';
}

export interface MediaAssetVariant {
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  size: number;
}

export interface MediaIngestResponse {
  assetId: string;
  original: MediaAssetVariant;
  variants: MediaAssetVariant[];
  sha256: string;
  createdAt: string;
}
