import { safetyAdapters } from '../adapters';
import { runSafetyAdapters } from '../adapters/safetySignals';
import { MediaStreams } from '../contracts/MediaStreams';
import { processVideo } from '../processing/video';
import { sha256 } from '../processing/image';
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
  stream: MediaStreams.PROCESS_VIDEO,
  group: 'media',
  consumer: 'process-video-worker-1',
  handler: async (message) => {
    const transientKey = message.sourceObjectKey || '';
    const input = transientKey
      ? await downloadFromFilebase(transientKey)
      : Buffer.from(message.bytesBase64 || '', 'base64');

    if (!input.byteLength) {
      throw new Error('Missing video payload for processing');
    }

    const processed = await processVideo(input, message.mimeType);

    const fileHash = sha256(processed.buffer);
    const extension = processed.mimeType === 'video/webm'
      ? 'webm'
      : processed.mimeType === 'video/quicktime'
        ? 'mov'
        : 'mp4';
    const originalKey = `${fileHash}.${extension}`;

    const original = await uploadToFilebase({
      key: originalKey,
      body: processed.buffer,
      contentType: processed.mimeType
    });

    const existingSignals = message.signals ? JSON.parse(message.signals) : [];
    const contentSignals = await runSafetyAdapters(safetyAdapters, {
      url: buildCanonicalMediaUrl(original.key),
      mimeType: processed.mimeType
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
      previewUrl: '',
      thumbnailUrl: '',
      mimeType: processed.mimeType,
      size: String(processed.buffer.byteLength),
      width: '',
      height: '',
      signals: JSON.stringify([...existingSignals, ...contentSignals])
    });

    if (transientKey) {
      await deleteFromFilebase(transientKey);
    }
  }
});
