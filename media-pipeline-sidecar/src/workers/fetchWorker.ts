import { fetch } from 'undici';
import { safetyAdapters } from '../adapters';
import { runSafetyAdapters } from '../adapters/safetySignals';
import { MediaStreams } from '../contracts/MediaStreams';
import { config } from '../config/config';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { assertSafeRemoteUrl } from '../security/ssrfGuard';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
runSecureWorker({
  stream: MediaStreams.FETCH,
  group: 'media',
  consumer: 'fetch-worker-1',
  handler: async (message) => {
    const safeUrl = await assertSafeRemoteUrl(message.sourceUrl);
    const urlSignals = await runSafetyAdapters(safetyAdapters, { url: safeUrl.toString() });

    const res = await fetch(safeUrl, {
      maxRedirections: 3,
      headers: { 'user-agent': 'media-pipeline-sidecar/1.0' }
    });

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > config.maxDownloadBytes) {
      throw new Error('Downloaded media exceeds configured maximum');
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';

    await enqueue(MediaStreams.PROCESS_IMAGE, {
      traceId: message.traceId,
      ownerId: message.ownerId,
      alt: message.alt || '',
      contentWarning: message.contentWarning || '',
      isSensitive: message.isSensitive || 'false',
      sourceUrl: safeUrl.toString(),
      mimeType: contentType,
      bytesBase64: buffer.toString('base64'),
      signals: JSON.stringify(urlSignals)
    });
  }
});
