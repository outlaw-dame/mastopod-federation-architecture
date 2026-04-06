import { config } from '../config/config';
import { SafetySignalAdapter } from './safetySignals';
import { fetch } from 'undici';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export class SafeBrowsingAdapter implements SafetySignalAdapter {
  name = 'safe-browsing';

  async execute({ url }: { url?: string }) {
    if (!url || !config.safeBrowsingApiKey) return null;

    const params = new URLSearchParams();
    params.append('urls', url);
    const res = await fetch(`https://safebrowsing.googleapis.com/v5alpha1/urls:search?${params.toString()}&key=${config.safeBrowsingApiKey}`);

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
