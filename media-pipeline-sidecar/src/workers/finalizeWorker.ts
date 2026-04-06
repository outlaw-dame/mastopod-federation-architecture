import { MediaEvents } from '../contracts/MediaEvents';
import { MediaStreams } from '../contracts/MediaStreams';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { indexMediaAsset } from '../indexing/openSearchMediaIndexer';
import { runSecureWorker } from '../queue/secureWorker';
import { publishMediaEvent } from '../events/redpandaProducer';
import { saveAsset } from '../storage/assetStore';

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
      mimeType: message.mimeType,
      size: Number(message.size),
      width: message.width ? Number(message.width) : undefined,
      height: message.height ? Number(message.height) : undefined,
      canonicalUrl: message.canonicalUrl,
      gatewayUrl: message.gatewayUrl || undefined,
      variants: {
        original: message.canonicalUrl,
        preview: message.previewUrl || undefined
      },
      alt: message.alt || undefined,
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
