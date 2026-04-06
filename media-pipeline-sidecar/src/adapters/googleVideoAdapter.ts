import { config } from '../config/config';
import { SafetySignalAdapter } from './safetySignals';
import { fetch } from 'undici';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export class GoogleVideoAdapter implements SafetySignalAdapter {
  name = 'google-video';

  async execute({ url, mimeType }: { url?: string; mimeType?: string }) {
    if (!url || !mimeType?.startsWith('video/') || !config.googleVideoAccessToken) return null;

    const res = await fetch('https://videointelligence.googleapis.com/v1/videos:annotate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.googleVideoAccessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        inputUri: url,
        features: ['EXPLICIT_CONTENT_DETECTION']
      })
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
