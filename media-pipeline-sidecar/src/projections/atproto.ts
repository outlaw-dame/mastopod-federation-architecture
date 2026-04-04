import { CanonicalAsset } from '../contracts/CanonicalAsset.js';
import { ATProtoBinding } from '../contracts/ProtocolBindings.js';

export function projectToATProto(asset: CanonicalAsset, did: string): ATProtoBinding {
  return {
    assetId: asset.assetId,
    did,
    blobRef: asset.cid || asset.sha256,
    mimeType: asset.mimeType,
    size: asset.size,
    width: asset.width,
    height: asset.height
  };
}
