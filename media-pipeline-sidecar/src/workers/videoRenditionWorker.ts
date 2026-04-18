import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { safetyAdapters } from '../adapters';
import { parseSafetySignals, runSafetyAdapters, serializeSafetySignals } from '../adapters/safetySignals';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { logger } from '../logger';
import { renderVideoRenditions } from '../processing/video';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { buildCanonicalMediaUrl } from '../storage/cdnUrlBuilder';
import { downloadFromFilebaseToPath } from '../storage/filebaseClient';
import { persistVideoRenditions } from '../storage/videoArtifactPersistence';
import { cleanupWorkerScratchDir, createWorkerScratchDir } from '../utils/tempFiles';
import { serializePlaybackVariants, serializeStreamingManifests } from '../utils/playbackVariants';
import { assertVideoToolingReady } from '../utils/videoTooling';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
await assertVideoToolingReady();

runSecureWorker({
  stream: MediaStreams.RENDITION_VIDEO,
  group: 'media',
  consumer: 'video-rendition-worker-1',
  handler: async (message) => {
    let scratchDir: string | undefined;

    try {
      const originalObjectKey = message.originalObjectKey || '';
      if (!originalObjectKey) {
        throw new Error('Missing canonical video object key for rendition stage');
      }

      scratchDir = await createWorkerScratchDir('video-rendition');
      const inputPath = path.join(scratchDir, 'canonical-video.bin');
      await downloadFromFilebaseToPath(originalObjectKey, inputPath);

      let renditions;
      try {
        renditions = await renderVideoRenditions(inputPath, scratchDir, message.mimeType);
      } catch (error) {
        logger.warn({
          traceId: message.traceId || null,
          originalObjectKey,
          error: error instanceof Error ? error.message : String(error)
        }, 'video-rendition-worker-derivatives-failed');
        renditions = {};
      }

      const persistedRenditions = await persistVideoRenditions(message.sha256, renditions);

      const existingSignals = parseSafetySignals(message.signals);
      const previewBuffer = renditions.previewPath ? await readFile(renditions.previewPath) : undefined;
      const contentSignals = await runSafetyAdapters(safetyAdapters, {
        url: message.canonicalUrl || buildCanonicalMediaUrl(originalObjectKey),
        buffer: previewBuffer,
        mimeType: previewBuffer ? 'image/webp' : message.mimeType
      });

      await enqueue(MediaStreams.FINALIZE, {
        traceId: message.traceId,
        ownerId: message.ownerId,
        sourceUrl: message.sourceUrl || '',
        alt: message.alt || '',
        contentWarning: message.contentWarning || '',
        isSensitive: message.isSensitive || 'false',
        sha256: message.sha256,
        cid: message.cid || '',
        canonicalUrl: message.canonicalUrl || buildCanonicalMediaUrl(originalObjectKey),
        gatewayUrl: message.gatewayUrl || '',
        previewUrl: persistedRenditions.previewUrl || '',
        thumbnailUrl: persistedRenditions.thumbnailUrl || '',
        playbackVariants: serializePlaybackVariants(persistedRenditions.playbackVariants),
        streamingManifests: serializeStreamingManifests(persistedRenditions.streamingManifests),
        mimeType: message.mimeType,
        size: message.size,
        duration: renditions.duration || '',
        width: renditions.width ? String(renditions.width) : '',
        height: renditions.height ? String(renditions.height) : '',
        signals: serializeSafetySignals([...existingSignals, ...contentSignals], config.maxSignalPayloadBytes)
      });
    } finally {
      await cleanupWorkerScratchDir(scratchDir);
    }
  }
});
