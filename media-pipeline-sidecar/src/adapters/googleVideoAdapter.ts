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
export class GoogleVideoAdapter implements SafetySignalAdapter {
  name = 'google-video';

  async execute(input: { url?: string; buffer?: Buffer; mimeType?: string }): Promise<SafetySignal | null> {
    const { url, mimeType } = input;
    if (!url || !mimeType?.startsWith('video/') || !config.googleVideoAccessToken) return null;

    const res = await retryAsync(async () => {
      const response = await fetch('https://videointelligence.googleapis.com/v1/videos:annotate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.googleVideoAccessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          inputUri: url,
          features: ['EXPLICIT_CONTENT_DETECTION']
        }),
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });

      if (response.status >= 500 || response.status === 429) {
        throw new RetryableMediaPipelineError({
          code: 'VIDEO_INTELLIGENCE_TRANSIENT',
          message: `Transient Video Intelligence API error: ${response.status}`,
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
      throw new Error(`Video Intelligence error: ${await res.text()}`);
    }

    const json = await res.json() as any;
    return {
      source: 'google-video',
      labels: ['video-analysis-requested'],
      raw: json
    };
  }
}
