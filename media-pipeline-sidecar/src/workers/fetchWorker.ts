import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { fetch } from 'undici';
import { safetyAdapters } from '../adapters';
import { runSafetyAdapters, serializeSafetySignals } from '../adapters/safetySignals';
import { config } from '../config/config';
import { MediaStreams } from '../contracts/MediaStreams';
import { validateMediaPayload } from '../ingest/mimeValidation';
import { logger } from '../logger';
import { enqueue } from '../queue/producer';
import { runSecureWorker } from '../queue/secureWorker';
import { assertSafeRemoteUrl } from '../security/ssrfGuard';
import { deleteFromFilebase, uploadTransientToFilebase } from '../storage/filebaseClient';
import { NonRetryableMediaPipelineError, RetryableMediaPipelineError, isLikelyTransientError } from '../utils/errorHandling';
import { cleanupWorkerScratchDir, createWorkerScratchDir } from '../utils/tempFiles';
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
    let transientObjectKey: string | null = null;
    let scratchDir: string | undefined;

    try {
      let resolvedSourceUrl = normalizeSourceUrl(message.sourceUrl);
      let serializedSignals = '[]';
      let validatedMedia:
        | Awaited<ReturnType<typeof validateMediaPayload>>
        | undefined;
      let download:
        | {
            sniffBuffer: Buffer;
          }
        | undefined;

      if (message.sourceResolver === 'activitypods-file') {
        scratchDir = await createWorkerScratchDir('fetch');
        const trustedResolution = await tryResolveTrustedActivityPodsSource(message, scratchDir);
        if (trustedResolution) {
          download = trustedResolution.download;
          validatedMedia = trustedResolution.validatedMedia;
          resolvedSourceUrl = trustedResolution.sourceUrl;
        }
      }

      if (!download || !validatedMedia) {
        const safeUrl = await assertSafeRemoteUrl(message.sourceUrl);
        const urlSignals = await runSafetyAdapters(safetyAdapters, { url: safeUrl.toString() });
        const res = await retryAsync(async () => {
          const response = await fetchWithValidatedRedirects(safeUrl, {
            timeoutMs: config.requestTimeoutMs,
            maxRedirects: 4
          });

          if (response.status >= 500 || response.status === 429) {
            throw new RetryableMediaPipelineError({
              code: 'FETCH_TRANSIENT_FAILURE',
              message: `Transient fetch failure: ${response.status}`,
              statusCode: response.status
            });
          }

          return response;
        }, {
          retries: 3,
          baseDelayMs: 400,
          maxDelayMs: 4000,
          shouldRetry: isLikelyTransientError
        });

        if (!res.ok) {
          throw new NonRetryableMediaPipelineError({
            code: 'FETCH_REJECTED',
            message: `Fetch failed: ${res.status}`,
            statusCode: res.status
          });
        }

        const contentLength = parseContentLength(res.headers.get('content-length'));
        if (contentLength !== undefined && contentLength > config.maxDownloadBytes) {
          throw new NonRetryableMediaPipelineError({
            code: 'FETCH_CONTENT_LENGTH_EXCEEDED',
            message: 'Remote media exceeds configured maximum before download'
          });
        }

        if (!scratchDir) {
          scratchDir = await createWorkerScratchDir('fetch');
        }
        const spoolPath = path.join(scratchDir, 'source.bin');
        download = await readBodyToTempFile(res, {
          destinationPath: spoolPath,
          maxBytes: config.maxDownloadBytes,
          sniffBytes: config.mediaSniffBytes
        });

        const declaredMimeType = res.headers.get('content-type') || 'application/octet-stream';
        validatedMedia = await validateMediaPayload({
          buffer: download.sniffBuffer,
          declaredMimeType
        });
        resolvedSourceUrl = safeUrl.toString();
        serializedSignals = serializeSafetySignals(urlSignals, config.maxSignalPayloadBytes);
      }

      const targetStream = validatedMedia.kind === 'video'
        ? MediaStreams.PROCESS_VIDEO
        : MediaStreams.PROCESS_IMAGE;
      const spoolPath = path.join(scratchDir!, 'source.bin');

      transientObjectKey = (await uploadTransientToFilebase({
        filePath: spoolPath,
        contentType: validatedMedia.mimeType,
        traceId: message.traceId
      })).key;

      await enqueue(targetStream, {
        traceId: message.traceId,
        ownerId: message.ownerId,
        alt: message.alt || '',
        contentWarning: message.contentWarning || '',
        isSensitive: message.isSensitive || 'false',
        sourceUrl: resolvedSourceUrl,
        sourceResolver: message.sourceResolver || '',
        mimeType: validatedMedia.mimeType,
        sourceObjectKey: transientObjectKey,
        signals: serializedSignals
      });
    } catch (error) {
      if (transientObjectKey) {
        await deleteTransientObject(transientObjectKey, message.traceId);
      }
      throw error;
    } finally {
      await cleanupWorkerScratchDir(scratchDir);
    }
  }
});

async function tryResolveTrustedActivityPodsSource(
  message: Record<string, string>,
  scratchDir: string,
): Promise<{
  sourceUrl: string;
  download: { sniffBuffer: Buffer };
  validatedMedia: Awaited<ReturnType<typeof validateMediaPayload>>;
} | null> {
  const endpointUrl = buildTrustedMediaSourceEndpointUrl();
  if (!endpointUrl) {
    return null;
  }

  const sourceUrl = normalizeSourceUrl(message.sourceUrl);
  const requestBody = JSON.stringify({ sourceUrl });

  try {
    const response = await retryAsync(async () => {
      const nextResponse = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.activityPodsMediaSourceToken}`
        },
        body: requestBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });

      if (nextResponse.status === 429 || nextResponse.status >= 500) {
        throw new RetryableMediaPipelineError({
          code: 'TRUSTED_SOURCE_TRANSIENT_FAILURE',
          message: `Trusted media source resolver failed with HTTP ${nextResponse.status}`,
          statusCode: nextResponse.status
        });
      }

      return nextResponse;
    }, {
      retries: 3,
      baseDelayMs: 400,
      maxDelayMs: 4000,
      shouldRetry: isLikelyTransientError
    });

    if ([404, 415, 422, 501].includes(response.status)) {
      logger.warn({
        sourceUrl,
        statusCode: response.status
      }, 'fetch-worker-trusted-source-fallback');
      return null;
    }

    if (!response.ok) {
      throw new NonRetryableMediaPipelineError({
        code: 'TRUSTED_SOURCE_REJECTED',
        message: `Trusted media source resolver failed with HTTP ${response.status}`,
        statusCode: response.status
      });
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== undefined && contentLength > config.maxDownloadBytes) {
      throw new NonRetryableMediaPipelineError({
        code: 'TRUSTED_SOURCE_CONTENT_LENGTH_EXCEEDED',
        message: 'Trusted media source exceeds configured maximum before download'
      });
    }

    const spoolPath = path.join(scratchDir, 'source.bin');
    const download = await readBodyToTempFile(response, {
      destinationPath: spoolPath,
      maxBytes: config.maxDownloadBytes,
      sniffBytes: config.mediaSniffBytes
    });
    const declaredMimeType = response.headers.get('content-type') || 'application/octet-stream';
    const validatedMedia = await validateMediaPayload({
      buffer: download.sniffBuffer,
      declaredMimeType
    });

    return {
      sourceUrl,
      download,
      validatedMedia
    };
  } catch (error) {
    if (isLikelyTransientError(error)) {
      throw error;
    }

    if (
      error instanceof NonRetryableMediaPipelineError &&
      error.statusCode !== undefined &&
      [404, 415, 422, 501].includes(error.statusCode)
    ) {
      logger.warn({
        sourceUrl,
        statusCode: error.statusCode,
        error: error.message
      }, 'fetch-worker-trusted-source-fallback');
      return null;
    }

    throw error;
  }
}

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

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function buildTrustedMediaSourceEndpointUrl(): string | null {
  if (!config.activityPodsMediaSourceBaseUrl || !config.activityPodsMediaSourceToken) {
    return null;
  }

  return new URL(
    config.activityPodsMediaSourcePath,
    config.activityPodsMediaSourceBaseUrl,
  ).toString();
}

function normalizeSourceUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.username || parsed.password) {
    throw new Error('Userinfo is not permitted in media URLs');
  }
  return parsed.toString();
}

async function readBodyToTempFile(
  response: FetchResponse,
  options: { destinationPath: string; maxBytes: number; sniffBytes: number }
): Promise<{ sniffBuffer: Buffer }> {
  const body = response.body;
  if (!body) {
    throw new Error('Remote response had no body');
  }

  const writer = createWriteStream(options.destinationPath, { flags: 'w' });
  const sniffChunks: Buffer[] = [];
  let sniffCollected = 0;
  let total = 0;

  if (typeof body.getReader !== 'function') {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.byteLength > options.maxBytes) {
      throw new Error('Downloaded media exceeds configured maximum');
    }

    writer.end(fallback);
    await once(writer, 'finish');

    return {
      sniffBuffer: fallback.subarray(0, Math.min(fallback.byteLength, options.sniffBytes))
    };
  }

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > options.maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort cancellation to stop upstream transfer.
        }
        throw new Error('Downloaded media exceeds configured maximum');
      }

      if (sniffCollected < options.sniffBytes) {
        const remaining = options.sniffBytes - sniffCollected;
        const slice = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
        sniffChunks.push(slice);
        sniffCollected += slice.byteLength;
      }

      if (!writer.write(chunk)) {
        await once(writer, 'drain');
      }
    }

    writer.end();
    await once(writer, 'finish');
  } catch (error) {
    writer.destroy();
    throw error;
  }

  return {
    sniffBuffer: Buffer.concat(sniffChunks, sniffCollected)
  };
}

async function deleteTransientObject(key: string, traceId: string | undefined): Promise<void> {
  try {
    await deleteFromFilebase(key);
  } catch (error) {
    logger.warn({
      traceId: traceId || null,
      key,
      error: error instanceof Error ? error.message : String(error)
    }, 'fetch-worker-transient-cleanup-failed');
  }
}
