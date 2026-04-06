import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { ActivityPubMediaBinding } from '../contracts/ProtocolBindings';

export function projectToActivityPubMedia(asset: CanonicalAsset): ActivityPubMediaBinding {
  return {
    type: asset.mimeType.startsWith('image/') ? 'Image' : asset.mimeType.startsWith('video/') ? 'Video' : 'Document',
    url: asset.canonicalUrl,
    mediaType: asset.mimeType,
    name: asset.alt,
    summary: asset.contentWarning,
    sensitive: asset.isSensitive,
    width: asset.width,
    height: asset.height
  };
}
