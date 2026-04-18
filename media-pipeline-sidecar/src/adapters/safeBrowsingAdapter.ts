import { config } from '../config/config';
import type { SafetySignal, SafetySignalAdapter } from './safetySignals';
import { fetch } from 'undici';
import { RetryableMediaPipelineError } from '../utils/errorHandling';
import { retryAsync } from '../utils/retry';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export class SafeBrowsingAdapter implements SafetySignalAdapter {
  name = 'safe-browsing';

  async execute(input: { url?: string; buffer?: Buffer; mimeType?: string }): Promise<SafetySignal | null> {
    const { url } = input;
    if (!url || !config.safeBrowsingApiKey) return null;

    const params = new URLSearchParams();
    params.append('urls', url);
    const endpoint = `https://safebrowsing.googleapis.com/v5alpha1/urls:search?${params.toString()}`;
    const res = await retryAsync(async () => {
      const response = await fetch(endpoint, {
        headers: {
          'x-goog-api-key': config.safeBrowsingApiKey
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });

      if (response.status >= 500 || response.status === 429) {
        throw new RetryableMediaPipelineError({
          code: 'SAFE_BROWSING_TRANSIENT',
          message: `Transient Safe Browsing API error: ${response.status}`,
          statusCode: response.status
        });
      }

      return response;
    }, {
      retries: 2,
      baseDelayMs: 300,
      maxDelayMs: 2000
    });

    if (!res.ok) {
      throw new Error(`Safe Browsing error: ${await res.text()}`);
    }

    const json = await res.json() as any;
    const threats = Array.isArray(json.threats) ? json.threats : [];

    return {
      source: 'safe-browsing',
      labels: threats.length > 0 ? ['malicious-source'] : [],
      raw: json
    };
  }
}
