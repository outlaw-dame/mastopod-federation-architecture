import { fetch } from 'undici';
import { safetyAdapters } from '../adapters';
import { runSafetyAdapters } from '../adapters/safetySignals';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { validateMediaPayload } from '../ingest/mimeValidation';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { assertSafeRemoteUrl } from '../security/ssrfGuard';
import { retryAsync } from '../utils/retry';

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

    const res = await retryAsync(async () => {
      const response = await fetch(safeUrl, {
        maxRedirections: 3,
        headers: { 'user-agent': 'media-pipeline-sidecar/1.0' },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });

      if (response.status >= 500 || response.status === 429) {
        throw new Error(`Transient fetch failure: ${response.status}`);
      }

      return response;
    }, {
      retries: 3,
      baseDelayMs: 400,
      maxDelayMs: 4000
    });

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status}`);
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > config.maxDownloadBytes) {
      throw new Error('Remote media exceeds configured maximum before download');
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > config.maxDownloadBytes) {
      throw new Error('Downloaded media exceeds configured maximum');
    }

    const declaredMimeType = res.headers.get('content-type') || 'application/octet-stream';
    const validatedMedia = await validateMediaPayload({
      buffer,
      declaredMimeType
    });

    const targetStream = validatedMedia.kind === 'video'
      ? MediaStreams.PROCESS_VIDEO
      : MediaStreams.PROCESS_IMAGE;

    await enqueue(targetStream, {
      traceId: message.traceId,
      ownerId: message.ownerId,
      alt: message.alt || '',
      contentWarning: message.contentWarning || '',
      isSensitive: message.isSensitive || 'false',
      sourceUrl: safeUrl.toString(),
      mimeType: validatedMedia.mimeType,
      bytesBase64: buffer.toString('base64'),
      signals: JSON.stringify(urlSignals)
    });
  }
});
