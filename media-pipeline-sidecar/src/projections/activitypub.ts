import { CanonicalAsset } from '../contracts/CanonicalAsset.js';
import { ActivityPubBinding } from '../contracts/ProtocolBindings.js';

export function projectToActivityPub(asset: CanonicalAsset): ActivityPubBinding {
  return {
    assetId: asset.assetId,
    url: asset.canonicalUrl,
    previewUrl: asset.variants.find(v => v.label === 'thumbnail')?.url,
    mediaType: asset.mimeType,
    width: asset.width,
    height: asset.height
  };
}
