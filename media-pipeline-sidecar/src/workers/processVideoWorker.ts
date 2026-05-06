import path from 'node:path';
import { MediaStreams } from '../contracts/MediaStreams';
import { logger } from '../logger';
import { processVideoFile, processAnimatedGifToWebP, videoExtensionForMime } from '../processing/video';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { buildCanonicalMediaUrl, buildGatewayUrl } from '../storage/cdnUrlBuilder';
import { deleteFromFilebase, downloadFromFilebaseToPath, uploadFileToFilebase, uploadToFilebase } from '../storage/filebaseClient';
import { cleanupWorkerScratchDir, createWorkerScratchDir } from '../utils/tempFiles';
import { readFile } from 'node:fs/promises';

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

      if (message.isAnimatedGif === 'true') {
        // Animated GIF path: FFmpeg → animated WebP, then directly to FINALIZE
        await processAnimatedGifMessage({ message, inputPath, scratchDir, transientKey });
        deleteTransientOnExit = true;
        return;
      }

      // Standard video path
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

async function processAnimatedGifMessage(params: {
  message: Record<string, string>;
  inputPath: string;
  scratchDir: string;
  transientKey: string;
}): Promise<void> {
  const { message, inputPath, scratchDir } = params;

  const gif = await processAnimatedGifToWebP(inputPath, scratchDir);

  const webpKey = `${gif.sha256}.webp`;
  const thumbnailKey = `${gif.sha256}-thumb.webp`;

  const [original, thumbnail] = await Promise.all([
    uploadFileToFilebase({
      key: webpKey,
      filePath: gif.webpPath,
      contentType: 'image/webp',
      resolveCid: true,
      objectClass: 'canonical-original'
    }),
    (async () => {
      const thumbBuffer = await readFile(gif.thumbnailPath);
      return uploadToFilebase({
        key: thumbnailKey,
        body: thumbBuffer,
        contentType: 'image/webp',
        objectClass: 'image-thumbnail'
      });
    })()
  ]);

  await enqueue(MediaStreams.FINALIZE, {
    traceId: message.traceId,
    ownerId: message.ownerId,
    sourceUrl: message.sourceUrl || '',
    alt: message.alt || '',
    contentWarning: message.contentWarning || '',
    isSensitive: message.isSensitive || 'false',
    sha256: gif.sha256,
    cid: original.cid || '',
    canonicalUrl: buildCanonicalMediaUrl(original.key),
    gatewayUrl: buildGatewayUrl(original.cid) || '',
    previewUrl: '',
    thumbnailUrl: buildCanonicalMediaUrl(thumbnail.key),
    mimeType: 'image/webp',
    size: String(gif.size),
    width: gif.width ? String(gif.width) : '',
    height: gif.height ? String(gif.height) : '',
    duration: '',
    playbackVariants: '',
    streamingManifests: '',
    signals: message.signals || '[]'
  });

  logger.debug(
    { traceId: message.traceId, sha256: gif.sha256 },
    'process-video-worker-animated-gif-done'
  );
}

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
