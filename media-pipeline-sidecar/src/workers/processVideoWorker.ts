import path from 'node:path';
import { MediaStreams } from '../contracts/MediaStreams';
import { logger } from '../logger';
import { processVideoFile, videoExtensionForMime } from '../processing/video';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { buildCanonicalMediaUrl, buildGatewayUrl } from '../storage/cdnUrlBuilder';
import { deleteFromFilebase, downloadFromFilebaseToPath, uploadFileToFilebase } from '../storage/filebaseClient';
import { cleanupWorkerScratchDir, createWorkerScratchDir } from '../utils/tempFiles';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
runSecureWorker({
  stream: MediaStreams.PROCESS_VIDEO,
  group: 'media',
  consumer: 'process-video-worker-1',
  handler: async (message) => {
    const transientKey = message.sourceObjectKey || '';
    let scratchDir: string | undefined;
    let deleteTransientOnExit = false;

    try {
      if (!transientKey) {
        throw new Error('Missing transient video object reference');
      }

      scratchDir = await createWorkerScratchDir('process-video');
      const inputPath = path.join(scratchDir, 'source-video.bin');
      await downloadFromFilebaseToPath(transientKey, inputPath);

      const processed = await processVideoFile(inputPath, message.mimeType);
      const original = await uploadFileToFilebase({
        key: `${processed.sha256}.${videoExtensionForMime(processed.mimeType)}`,
        filePath: inputPath,
        contentType: processed.mimeType,
        resolveCid: true,
        objectClass: 'canonical-original'
      });

      await enqueue(MediaStreams.RENDITION_VIDEO, {
        traceId: message.traceId,
        ownerId: message.ownerId,
        sourceUrl: message.sourceUrl || '',
        alt: message.alt || '',
        contentWarning: message.contentWarning || '',
        isSensitive: message.isSensitive || 'false',
        sha256: processed.sha256,
        cid: original.cid || '',
        originalObjectKey: original.key,
        canonicalUrl: buildCanonicalMediaUrl(original.key),
        gatewayUrl: buildGatewayUrl(original.cid) || '',
        mimeType: processed.mimeType,
        size: String(processed.size),
        signals: message.signals || '[]'
      });

      deleteTransientOnExit = true;
    } finally {
      if (deleteTransientOnExit && transientKey) {
        await deleteTransientObject(transientKey, message.traceId);
      }
      await cleanupWorkerScratchDir(scratchDir);
    }
  }
});

async function deleteTransientObject(key: string, traceId: string | undefined): Promise<void> {
  try {
    await deleteFromFilebase(key);
  } catch (error) {
    logger.warn({
      traceId: traceId || null,
      key,
      error: error instanceof Error ? error.message : String(error)
    }, 'process-video-worker-transient-cleanup-failed');
  }
}
