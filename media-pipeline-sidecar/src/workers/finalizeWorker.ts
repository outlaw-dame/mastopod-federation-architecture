import { MediaEvents } from '../contracts/MediaEvents';
import { MediaStreams } from '../contracts/MediaStreams';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { indexMediaAsset } from '../indexing/openSearchMediaIndexer';
import { runSecureWorker } from '../queue/secureWorker';
import { publishMediaEvent } from '../events/redpandaProducer';
import { saveAsset } from '../storage/assetStore';
import { sha256HexToDigestMultibase } from '../utils/digest';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
runSecureWorker({
  stream: MediaStreams.FINALIZE,
  group: 'media',
  consumer: 'finalize-worker-1',
  handler: async (message) => {
    const asset: CanonicalAsset = {
      assetId: message.sha256,
      ownerId: message.ownerId,
      sha256: message.sha256,
      cid: message.cid || undefined,
      digestMultibase: message.digestMultibase || sha256HexToDigestMultibase(message.sha256),
      mimeType: message.mimeType,
      size: Number(message.size),
      duration: message.duration || undefined,
      width: message.width ? Number(message.width) : undefined,
      height: message.height ? Number(message.height) : undefined,
      focalPoint: parseFocalPoint(message.focalPoint),
      canonicalUrl: message.canonicalUrl,
      gatewayUrl: message.gatewayUrl || undefined,
      variants: {
        original: message.canonicalUrl,
        preview: message.previewUrl || undefined,
        thumbnail: message.thumbnailUrl || undefined
      },
      alt: message.alt || undefined,
      blurhash: message.blurhash || undefined,
      contentWarning: message.contentWarning || undefined,
      isSensitive: message.isSensitive === 'true',
      createdAt: new Date().toISOString()
    };

    const signals = message.signals ? JSON.parse(message.signals) : [];
    await saveAsset(asset);
    await indexMediaAsset(asset, signals);
    await publishMediaEvent(MediaEvents.ASSET_CREATED, { asset, signals });
  }
});

function parseFocalPoint(value: unknown): [number, number] | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
  }

  if (typeof value === 'string') {
    try {
      return parseFocalPoint(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  return undefined;
}
