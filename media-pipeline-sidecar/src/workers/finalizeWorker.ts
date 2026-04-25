import { MediaEvents } from '../contracts/MediaEvents';
import { MediaStreams } from '../contracts/MediaStreams';
import { CanonicalAsset } from '../contracts/CanonicalAsset';
import { indexMediaAssets } from '../indexing/openSearchMediaIndexer';
import { config } from '../config/config';
import { parseSafetySignals } from '../adapters/safetySignals';
import { runSecureWorker } from '../queue/secureWorker';
import { publishMediaEvent } from '../events/redpandaProducer';
import { saveAsset } from '../storage/assetStore';
import { sha256HexToDigestMultibase } from '../utils/digest';
import { parsePlaybackVariants, parseStreamingManifests } from '../utils/playbackVariants';
import { projectToActivityPubMedia } from '../projection/activitypubMedia';

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
  readCount: config.opensearchBulkIndexBatchSize,
  handler: async (message) => {
    await persistAndPublish([message]);
  },
  batchHandler: async (messages) => {
    const rawMessages = messages.map((message) => message.message);
    const indexedAssets = buildAssets(rawMessages);
    await indexMediaAssets(indexedAssets);

    const handledMessageIds: string[] = [];
    const failedMessages: typeof messages = [];

    for (let index = 0; index < messages.length; index += 1) {
      const indexedAsset = indexedAssets[index];
      try {
        const persistedAsset = await saveAsset(indexedAsset.asset);
        await publishMediaEvent(MediaEvents.ASSET_CREATED, {
          asset: persistedAsset,
          signals: indexedAsset.signals,
          bindings: {
            activitypub: projectToActivityPubMedia(persistedAsset),
          },
        });
        handledMessageIds.push(messages[index].id);
      } catch {
        failedMessages.push(messages[index]);
      }
    }

    return {
      handledMessageIds,
      failedMessages
    };
  }
});

async function persistAndPublish(messages: Array<Record<string, string>>): Promise<void> {
  const indexedAssets = buildAssets(messages);
  await indexMediaAssets(indexedAssets);

  for (const indexedAsset of indexedAssets) {
    const persistedAsset = await saveAsset(indexedAsset.asset);
    await publishMediaEvent(MediaEvents.ASSET_CREATED, {
      asset: persistedAsset,
      signals: indexedAsset.signals,
      bindings: {
        activitypub: projectToActivityPubMedia(persistedAsset),
      },
    });
  }
}

function buildAssets(messages: Array<Record<string, string>>): Array<{ asset: CanonicalAsset; signals: ReturnType<typeof parseSafetySignals> }> {
  return messages.map((message) => {
    const createdAt = new Date().toISOString();
    const asset: CanonicalAsset = {
      assetId: message.sha256,
      ownerId: message.ownerId,
      ownerIds: [message.ownerId],
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
      sourceUrls: message.sourceUrl ? [message.sourceUrl] : undefined,
      variants: {
        original: message.canonicalUrl,
        preview: message.previewUrl || undefined,
        thumbnail: message.thumbnailUrl || undefined,
        playback: parsePlaybackVariants(message.playbackVariants),
        streaming: parseStreamingManifests(message.streamingManifests)
      },
      alt: message.alt || undefined,
      blurhash: message.blurhash || undefined,
      contentWarning: message.contentWarning || undefined,
      isSensitive: message.isSensitive === 'true',
      createdAt,
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      ingestCount: 1
    };

    return {
      asset,
      signals: parseSafetySignals(message.signals)
    };
  });
}

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
