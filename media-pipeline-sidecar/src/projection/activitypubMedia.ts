import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { ActivityPubMediaBinding } from '../contracts/ProtocolBindings';
import { sha256HexToDigestMultibase } from '../utils/digest';

export function projectToActivityPubMedia(asset: CanonicalAsset): ActivityPubMediaBinding {
  return {
    type: asset.mimeType.startsWith('image/')
      ? 'Image'
      : asset.mimeType.startsWith('video/')
        ? 'Video'
        : asset.mimeType.startsWith('audio/')
          ? 'Audio'
          : 'Document',
    url: asset.canonicalUrl,
    mediaType: asset.mimeType,
    name: asset.alt,
    summary: asset.contentWarning,
    sensitive: asset.isSensitive,
    size: asset.size,
    duration: asset.duration,
    digestMultibase: asset.digestMultibase || sha256HexToDigestMultibase(asset.sha256),
    width: asset.width,
    height: asset.height,
    focalPoint: asset.focalPoint,
    blurhash: asset.blurhash
  };
}
