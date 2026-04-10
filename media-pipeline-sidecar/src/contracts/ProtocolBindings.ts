export interface ActivityPubMediaBinding {
  type: 'Image' | 'Document' | 'Video' | 'Audio';
  url: string;
  mediaType: string;
  name?: string;
  summary?: string;
  sensitive?: boolean;
  size?: number;
  duration?: string | number;
  digestMultibase?: string;
  width?: number;
  height?: number;
  focalPoint?: [number, number];
  blurhash?: string;
}

export interface ATProtoMediaBinding {
  $type: string;
  images?: Array<{
    alt: string;
    image: unknown;
    aspectRatio?: { width: number; height: number };
  }>;
}
