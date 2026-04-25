import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { ATProtoMediaBinding } from '../contracts/ProtocolBindings';

export function projectToATProtoMedia(asset: CanonicalAsset, blobRef: unknown): ATProtoMediaBinding {
  return {
    $type: 'app.bsky.embed.images',
    images: [
      {
        alt: asset.alt || '',
        image: blobRef,
        aspectRatio: asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined
      }
    ]
  };
}
