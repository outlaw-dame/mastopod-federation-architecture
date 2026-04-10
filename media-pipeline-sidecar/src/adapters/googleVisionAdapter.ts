import { config } from '../config/config';
import type { SafetySignal, SafetySignalAdapter } from './safetySignals';
import { fetch } from 'undici';
import { retryAsync } from '../utils/retry';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export class GoogleVisionAdapter implements SafetySignalAdapter {
  name = 'google-vision';

  async execute(input: { url?: string; buffer?: Buffer; mimeType?: string }): Promise<SafetySignal | null> {
    const { buffer } = input;
    if (!buffer || !config.googleVisionApiKey) return null;

    const base64Image = buffer.toString('base64');
    const res = await retryAsync(async () => {
      const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.googleVisionApiKey
        },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64Image },
              features: [{ type: 'SAFE_SEARCH_DETECTION' }]
            }
          ]
        }),
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });

      if (response.status >= 500 || response.status === 429) {
        throw new Error(`Transient Vision API error: ${response.status}`);
      }

      return response;
    }, {
      retries: 2,
      baseDelayMs: 300,
      maxDelayMs: 2000
    });

    if (!res.ok) {
      throw new Error(`Vision API error: ${await res.text()}`);
    }

    const json = await res.json() as any;
    const annotation = json.responses?.[0]?.safeSearchAnnotation || {};
    const labels: string[] = [];

    if (annotation.adult === 'LIKELY' || annotation.adult === 'VERY_LIKELY' || annotation.racy === 'LIKELY' || annotation.racy === 'VERY_LIKELY') {
      labels.push('nsfw');
    }
    if (annotation.violence === 'LIKELY' || annotation.violence === 'VERY_LIKELY') {
      labels.push('graphic-media');
    }

    return {
      source: 'google-vision',
      labels,
      raw: annotation
    };
  }
}
