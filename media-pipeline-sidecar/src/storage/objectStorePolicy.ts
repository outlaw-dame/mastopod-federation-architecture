import { config } from '../config/config';
import type { MediaObjectClass, MediaObjectPolicy } from './objectStoreTypes';

export function buildPutObjectPolicy(
  key: string,
  contentType: string,
  objectClass: MediaObjectClass
): MediaObjectPolicy {
  const taggingPairs = new URLSearchParams();
  const metadata: Record<string, string> = {
    'managed-by': 'media-pipeline-sidecar'
  };

  let cacheControl = config.immutableAssetCacheControl;
  let mediaClass = 'derived';
  let mediaRole = 'asset';

  switch (objectClass) {
    case 'canonical-original':
      mediaClass = 'canonical';
      mediaRole = 'original';
      break;
    case 'image-preview':
      mediaRole = 'preview';
      break;
    case 'image-thumbnail':
      mediaRole = 'thumbnail';
      break;
    case 'video-playback':
      mediaRole = 'playback';
      break;
    case 'streaming-manifest':
      mediaClass = 'streaming';
      mediaRole = 'manifest';
      cacheControl = config.streamingManifestCacheControl;
      break;
    case 'streaming-segment':
      mediaClass = 'streaming';
      mediaRole = 'segment';
      break;
    case 'transient':
      mediaClass = 'transient';
      mediaRole = 'source';
      cacheControl = config.transientObjectCacheControl;
      break;
  }

  metadata['media-class'] = mediaClass;
  metadata['media-role'] = mediaRole;
  metadata['content-type'] = contentType;
  taggingPairs.set('media-class', mediaClass);
  taggingPairs.set('media-role', mediaRole);

  if (objectClass === 'transient') {
    taggingPairs.set('retention-class', 'ephemeral');
  }

  if (objectClass === 'streaming-manifest' || objectClass === 'streaming-segment') {
    const protocol = key.includes('/dash/') ? 'dash' : key.includes('/hls/') ? 'hls' : 'unknown';
    metadata.protocol = protocol;
    taggingPairs.set('streaming-protocol', protocol);
  }

  return {
    cacheControl,
    contentDisposition: 'inline',
    metadata,
    tagging: taggingPairs.toString()
  };
}
