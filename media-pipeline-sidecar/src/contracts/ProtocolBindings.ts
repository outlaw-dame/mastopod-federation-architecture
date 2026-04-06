export interface ActivityPubMediaBinding {
  type: 'Image' | 'Document' | 'Video';
  url: string;
  mediaType: string;
  name?: string;
  summary?: string;
  sensitive?: boolean;
  width?: number;
  height?: number;
}

export interface ATProtoMediaBinding {
  $type: string;
  images?: Array<{
    alt: string;
    image: unknown;
    aspectRatio?: { width: number; height: number };
  }>;
}
