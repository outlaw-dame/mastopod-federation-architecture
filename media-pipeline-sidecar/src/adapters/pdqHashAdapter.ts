import { fetch } from 'undici';
import { config } from '../config/config';
import type { SafetySignal, SafetySignalAdapter } from './safetySignals';
import { RetryableMediaPipelineError } from '../utils/errorHandling';
import { retryAsync } from '../utils/retry';

function buildPdqHashEndpoint(baseUrl: string): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('pdq-hash', normalized).toString();
}

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 *
 * The PDQ hash endpoint follows the same shape PieFed documents:
 *   GET /pdq-hash?image_url=<public-image-url>
 * -> { "pdq_hash_binary": "...", "quality": 88 }
 */
export class PdqHashAdapter implements SafetySignalAdapter {
  name = 'pdq-hash';

  async execute(input: { url?: string; buffer?: Buffer; mimeType?: string }): Promise<SafetySignal | null> {
    const { url, mimeType } = input;
    if (!url || !mimeType?.startsWith('image/') || !config.pdqHashServiceBaseUrl) {
      return null;
    }

    const endpoint = new URL(buildPdqHashEndpoint(config.pdqHashServiceBaseUrl));
    endpoint.searchParams.set('image_url', url);

    const res = await retryAsync(async () => {
      const response = await fetch(endpoint, {
        headers: {
          accept: 'application/json',
          ...(config.pdqHashServiceBearerToken
            ? { authorization: `Bearer ${config.pdqHashServiceBearerToken}` }
            : {}),
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      if (response.status >= 500 || response.status === 429) {
        throw new RetryableMediaPipelineError({
          code: 'PDQ_HASH_TRANSIENT',
          message: `Transient PDQ hash service error: ${response.status}`,
          statusCode: response.status,
        });
      }

      return response;
    }, {
      retries: 2,
      baseDelayMs: 300,
      maxDelayMs: 2000,
    });

    if (!res.ok) {
      throw new Error(`PDQ hash service error: ${await res.text()}`);
    }

    const json = await res.json() as {
      pdq_hash_binary?: unknown;
      quality?: unknown;
    };

    const pdqHashBinary = typeof json.pdq_hash_binary === 'string' ? json.pdq_hash_binary.trim() : '';
    const quality = typeof json.quality === 'number' ? Math.max(0, Math.min(100, Math.trunc(json.quality))) : null;

    if (!/^[01]{256}$/.test(pdqHashBinary) || quality === null) {
      return null;
    }

    return {
      source: 'pdq-hash',
      labels: ['pdq-hash'],
      confidence: quality / 100,
      raw: {
        pdqHashBinary,
        quality,
      },
    };
  }
}
