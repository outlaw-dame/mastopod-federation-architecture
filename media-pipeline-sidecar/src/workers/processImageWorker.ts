import { safetyAdapters } from '../adapters';
import { runSafetyAdapters } from '../adapters/safetySignals';
import { MediaStreams } from '../contracts/MediaStreams';
import { processImage, sha256 } from '../processing/image';
import { generateBlurPreview } from '../processing/blurPreview';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { uploadToFilebase } from '../storage/filebaseClient';

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
    const input = Buffer.from(message.bytesBase64, 'base64');
    const processed = await processImage(input);
    const blurPreview = await generateBlurPreview(input);

    const fileHash = sha256(processed.buffer);
    const originalKey = `${fileHash}.webp`;
    const previewKey = `${fileHash}-preview.webp`;

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

    const existingSignals = message.signals ? JSON.parse(message.signals) : [];
    const contentSignals = await runSafetyAdapters(safetyAdapters, {
      url: original.url,
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
      canonicalUrl: original.url,
      gatewayUrl: original.cid ? original.url.replace(originalKey, '').replace(/\/$/, '') + '/' + original.cid : '',
      previewUrl: preview.url,
      mimeType: 'image/webp',
      size: String(processed.buffer.byteLength),
      width: String(processed.width || ''),
      height: String(processed.height || ''),
      signals: JSON.stringify([...existingSignals, ...contentSignals])
    });
  }
});
