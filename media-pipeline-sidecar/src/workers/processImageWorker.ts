import { safetyAdapters } from '../adapters';
import { runSafetyAdapters } from '../adapters/safetySignals';
import { MediaStreams } from '../contracts/MediaStreams';
import { processImage, sha256 } from '../processing/image';
import { generateBlurPreview } from '../processing/blurPreview';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { buildCanonicalMediaUrl, buildGatewayUrl } from '../storage/cdnUrlBuilder';
import { deleteFromFilebase, downloadFromFilebase, uploadToFilebase } from '../storage/filebaseClient';

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
    const input = transientKey
      ? await downloadFromFilebase(transientKey)
      : Buffer.from(message.bytesBase64 || '', 'base64');

    if (!input.byteLength) {
      throw new Error('Missing image payload for processing');
    }

    const processed = await processImage(input);
    const blurPreview = await generateBlurPreview(processed.buffer);

    const fileHash = sha256(processed.buffer);
    const originalKey = `${fileHash}.webp`;
    const previewKey = `${fileHash}-preview.webp`;
    const thumbnailKey = `${fileHash}-thumb.webp`;

    const original = await uploadToFilebase({
      key: originalKey,
      body: processed.buffer,
      contentType: 'image/webp'
    });
    const preview = await uploadToFilebase({
      key: previewKey,
      body: blurPreview,
      contentType: 'image/webp'
    });
    const thumbnail = processed.thumbnail
      ? await uploadToFilebase({
          key: thumbnailKey,
          body: processed.thumbnail,
          contentType: 'image/webp'
        })
      : null;

    const existingSignals = message.signals ? JSON.parse(message.signals) : [];
    const contentSignals = await runSafetyAdapters(safetyAdapters, {
      url: buildCanonicalMediaUrl(original.key),
      buffer: processed.buffer,
      mimeType: 'image/webp'
    });

    await enqueue(MediaStreams.FINALIZE, {
      traceId: message.traceId,
      ownerId: message.ownerId,
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
      signals: JSON.stringify([...existingSignals, ...contentSignals])
    });

    if (transientKey) {
      await deleteFromFilebase(transientKey);
    }
  }
});
