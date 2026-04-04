export interface ActivityPubBinding {
  assetId: string;
  url: string;
  previewUrl?: string;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface ATProtoBinding {
  assetId: string;
  did: string;
  blobRef: string; // opaque reference to blob
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}
