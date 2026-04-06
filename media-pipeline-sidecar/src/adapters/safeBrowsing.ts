import { SafetySignalAdapter } from './safetySignals';

export class SafeBrowsingAdapter implements SafetySignalAdapter {
  name = 'safe-browsing';

  async execute({ url }: { url?: string }) {
    if (!url) return null;

    const result = await checkUrl(url);

    return {
      source: 'safe-browsing',
      labels: mapThreats(result),
      raw: result
    };
  }
}
