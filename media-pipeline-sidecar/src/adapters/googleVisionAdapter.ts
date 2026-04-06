import { config } from '../config/config';
import { SafetySignalAdapter } from './safetySignals';
import { fetch } from 'undici';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export class GoogleVisionAdapter implements SafetySignalAdapter {
  name = 'google-vision';

  async execute({ buffer }: { buffer?: Buffer }) {
    if (!buffer || !config.googleVisionApiKey) return null;

    const base64Image = buffer.toString('base64');
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${config.googleVisionApiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64Image },
            features: [{ type: 'SAFE_SEARCH_DETECTION' }]
          }
        ]
      })
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
