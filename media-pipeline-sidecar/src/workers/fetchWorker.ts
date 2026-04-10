import { fetch } from 'undici';
import { safetyAdapters } from '../adapters';
import { runSafetyAdapters } from '../adapters/safetySignals';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { validateMediaPayload } from '../ingest/mimeValidation';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { assertSafeRemoteUrl } from '../security/ssrfGuard';
import { uploadTransientToFilebase } from '../storage/filebaseClient';
import { retryAsync } from '../utils/retry';

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

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
      const response = await fetchWithValidatedRedirects(safeUrl, {
        timeoutMs: config.requestTimeoutMs,
        maxRedirects: 4
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

    const buffer = await readBodyWithLimit(res, config.maxDownloadBytes);

    const declaredMimeType = res.headers.get('content-type') || 'application/octet-stream';
    const validatedMedia = await validateMediaPayload({
      buffer,
      declaredMimeType
    });

    const targetStream = validatedMedia.kind === 'video'
      ? MediaStreams.PROCESS_VIDEO
      : MediaStreams.PROCESS_IMAGE;

    const transientObject = await uploadTransientToFilebase({
      body: buffer,
      contentType: validatedMedia.mimeType,
      traceId: message.traceId
    });

    await enqueue(targetStream, {
      traceId: message.traceId,
      ownerId: message.ownerId,
      alt: message.alt || '',
      contentWarning: message.contentWarning || '',
      isSensitive: message.isSensitive || 'false',
      sourceUrl: safeUrl.toString(),
      mimeType: validatedMedia.mimeType,
      sourceObjectKey: transientObject.key,
      signals: JSON.stringify(urlSignals)
    });
  }
});

async function fetchWithValidatedRedirects(
  initialUrl: URL,
  options: { timeoutMs: number; maxRedirects: number }
): Promise<FetchResponse> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: { 'user-agent': 'media-pipeline-sidecar/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs)
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Redirect response missing location header');
    }

    if (redirectCount >= options.maxRedirects) {
      throw new Error('Too many redirects while fetching media');
    }

    const nextUrl = new URL(location, currentUrl);
    if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
      throw new Error('Refusing insecure redirect downgrade from https to non-https');
    }

    currentUrl = await assertSafeRemoteUrl(nextUrl.toString());
  }

  throw new Error('Unexpected redirect handling failure');
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBodyWithLimit(response: FetchResponse, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    throw new Error('Remote response had no body');
  }

  if (typeof body.getReader !== 'function') {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.byteLength > maxBytes) {
      throw new Error('Downloaded media exceeds configured maximum');
    }
    return fallback;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Best-effort cancellation to stop upstream transfer.
      }
      throw new Error('Downloaded media exceeds configured maximum');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}
