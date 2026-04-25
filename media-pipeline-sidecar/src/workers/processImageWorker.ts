import path from 'node:path';
import { safetyAdapters } from '../adapters';
import { parseSafetySignals, runSafetyAdapters, serializeSafetySignals } from '../adapters/safetySignals';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { logger } from '../logger';
import { processImage, processImageFile, sha256 } from '../processing/image';
import { generateBlurPreview } from '../processing/blurPreview';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { buildCanonicalMediaUrl, buildGatewayUrl } from '../storage/cdnUrlBuilder';
import { deleteFromFilebase, downloadFromFilebaseToPath, uploadToFilebase } from '../storage/filebaseClient';
import { cleanupWorkerScratchDir, createWorkerScratchDir } from '../utils/tempFiles';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
runSecureWorker({
  stream: MediaStreams.PROCESS_IMAGE,
  group: 'media',
  consumer: 'process-image-worker-1',
  handler: async (message) => {
    const transientKey = message.sourceObjectKey || '';
    let scratchDir: string | undefined;

    try {
      const processed = transientKey
        ? await processTransientImage(transientKey, (dir) => {
            scratchDir = dir;
          })
        : await processInlineImage(message.bytesBase64 || '');
      const blurPreview = await generateBlurPreview(processed.buffer);

      const fileHash = sha256(processed.buffer);
      const originalKey = `${fileHash}.webp`;
      const previewKey = `${fileHash}-preview.webp`;
      const thumbnailKey = `${fileHash}-thumb.webp`;

      const [original, preview, thumbnail] = await Promise.all([
        uploadToFilebase({
          key: originalKey,
          body: processed.buffer,
          contentType: 'image/webp',
          resolveCid: true,
          objectClass: 'canonical-original'
        }),
        uploadToFilebase({
          key: previewKey,
          body: blurPreview,
          contentType: 'image/webp',
          objectClass: 'image-preview'
        }),
        processed.thumbnail
          ? uploadToFilebase({
              key: thumbnailKey,
              body: processed.thumbnail,
              contentType: 'image/webp',
              objectClass: 'image-thumbnail'
            })
          : Promise.resolve(null)
      ]);

      const existingSignals = parseSafetySignals(message.signals);
      const contentSignals = await runSafetyAdapters(safetyAdapters, {
        url: buildCanonicalMediaUrl(original.key),
        buffer: processed.buffer,
        mimeType: 'image/webp'
      });

      await enqueue(MediaStreams.FINALIZE, {
        traceId: message.traceId,
        ownerId: message.ownerId,
        sourceUrl: message.sourceUrl || '',
        alt: message.alt || '',
        contentWarning: message.contentWarning || '',
        isSensitive: message.isSensitive || 'false',
        sha256: fileHash,
        cid: original.cid || '',
        canonicalUrl: buildCanonicalMediaUrl(original.key),
        gatewayUrl: buildGatewayUrl(original.cid) || '',
        previewUrl: buildCanonicalMediaUrl(preview.key),
        thumbnailUrl: thumbnail ? buildCanonicalMediaUrl(thumbnail.key) : '',
        mimeType: 'image/webp',
        size: String(processed.buffer.byteLength),
        width: String(processed.width || ''),
        height: String(processed.height || ''),
        signals: serializeSafetySignals([...existingSignals, ...contentSignals], config.maxSignalPayloadBytes)
      });
    } finally {
      if (transientKey) {
        await deleteTransientObject(transientKey, message.traceId);
      }
      await cleanupWorkerScratchDir(scratchDir);
    }
  }
});

async function processTransientImage(
  transientKey: string,
  onScratchDir: (dirPath: string) => void
): Promise<Awaited<ReturnType<typeof processImageFile>>> {
  const scratchDir = await createWorkerScratchDir('process-image');
  onScratchDir(scratchDir);
  const inputPath = path.join(scratchDir, 'source-image.bin');
  await downloadFromFilebaseToPath(transientKey, inputPath);
  return processImageFile(inputPath);
}

async function processInlineImage(base64Payload: string): Promise<Awaited<ReturnType<typeof processImage>>> {
  const input = Buffer.from(base64Payload, 'base64');
  if (!input.byteLength) {
    throw new Error('Missing image payload for processing');
  }

  return processImage(input);
}

async function deleteTransientObject(key: string, traceId: string | undefined): Promise<void> {
  try {
    await deleteFromFilebase(key);
  } catch (error) {
    logger.warn({
      traceId: traceId || null,
      key,
      error: error instanceof Error ? error.message : String(error)
    }, 'process-image-worker-transient-cleanup-failed');
  }
}
