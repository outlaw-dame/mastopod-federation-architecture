export type MediaObjectClass =
  | 'canonical-original'
  | 'image-preview'
  | 'image-thumbnail'
  | 'video-playback'
  | 'streaming-manifest'
  | 'streaming-segment'
  | 'transient';

export interface MediaObjectPolicy {
  cacheControl: string;
  contentDisposition: string;
  metadata: Record<string, string>;
  tagging: string;
}

export interface MediaObjectMetadata {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

export interface LocalMediaObjectHandle extends MediaObjectMetadata {
  exists: true;
  filePath: string;
  lastModified?: Date;
  etag?: string;
}
