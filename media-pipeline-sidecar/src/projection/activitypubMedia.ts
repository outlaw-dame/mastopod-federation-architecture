import { config } from '../config/config';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { ActivityPubMediaBinding } from '../contracts/ProtocolBindings';
import { sha256HexToDigestMultibase } from '../utils/digest';

export type MediaDeliveryProfile = 'activitypub' | 'first-party';
type DeliveryKind = 'original' | 'playback' | 'streaming';
type DeliveryCandidate = {
  url: string;
  mediaType: string;
  deliveryKind: DeliveryKind;
};

export function projectToActivityPubMedia(
  asset: CanonicalAsset,
  options?: { deliveryProfile?: MediaDeliveryProfile }
): ActivityPubMediaBinding {
  const preferredDelivery = selectPreferredDelivery(asset, options?.deliveryProfile || 'activitypub');

  return {
    type: asset.mimeType.startsWith('image/')
      ? 'Image'
      : asset.mimeType.startsWith('video/')
        ? 'Video'
        : asset.mimeType.startsWith('audio/')
          ? 'Audio'
          : 'Document',
    url: preferredDelivery.url,
    mediaType: preferredDelivery.mediaType,
    canonicalUrl: asset.canonicalUrl,
    name: asset.alt,
    summary: asset.contentWarning,
    sensitive: asset.isSensitive,
    size: asset.size,
    duration: asset.duration,
    digestMultibase: asset.digestMultibase || sha256HexToDigestMultibase(asset.sha256),
    width: asset.width,
    height: asset.height,
    focalPoint: asset.focalPoint,
    blurhash: asset.blurhash,
    gatewayUrl: asset.gatewayUrl,
    deliveryKind: preferredDelivery.deliveryKind,
    playback: asset.variants.playback,
    streaming: asset.variants.streaming
  };
}

export function selectPreferredDelivery(
  asset: CanonicalAsset,
  deliveryProfile: MediaDeliveryProfile = 'activitypub'
): DeliveryCandidate {
  if (asset.mimeType.startsWith('video/')) {
    const orderedCandidates = buildVideoDeliveryCandidates(asset, deliveryProfile);
    for (const candidate of orderedCandidates) {
      if (candidate.url) {
        return candidate;
      }
    }
  }

  return {
    url: asset.canonicalUrl,
    mediaType: asset.mimeType,
    deliveryKind: 'original'
  };
}

function buildVideoDeliveryCandidates(
  asset: CanonicalAsset,
  deliveryProfile: MediaDeliveryProfile
): DeliveryCandidate[] {
  const preferences = deliveryProfile === 'first-party'
    ? config.firstPartyVideoDeliveryOrder
    : config.activityPubVideoDeliveryOrder;

  const candidates: DeliveryCandidate[] = [];

  for (const preference of preferences) {
    switch (preference) {
      case 'playback': {
        const playback = asset.variants.playback?.find((candidate) => candidate.url);
        if (playback) {
          candidates.push({
            url: playback.url,
            mediaType: playback.mimeType,
            deliveryKind: 'playback'
          });
        }
        break;
      }
      case 'stream:hls': {
        const manifest = asset.variants.streaming?.find((candidate) => candidate.protocol === 'hls' && candidate.url);
        if (manifest) {
          candidates.push({
            url: manifest.url,
            mediaType: manifest.mimeType,
            deliveryKind: 'streaming'
          });
        }
        break;
      }
      case 'stream:dash': {
        const manifest = asset.variants.streaming?.find((candidate) => candidate.protocol === 'dash' && candidate.url);
        if (manifest) {
          candidates.push({
            url: manifest.url,
            mediaType: manifest.mimeType,
            deliveryKind: 'streaming'
          });
        }
        break;
      }
      case 'original':
      default:
        candidates.push({
          url: asset.canonicalUrl,
          mediaType: asset.mimeType,
          deliveryKind: 'original'
        });
        break;
    }
  }

  return candidates;
}
