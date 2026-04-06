/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export interface SafetySignal {
  source: 'google-vision' | 'google-video' | 'safe-browsing' | 'cloudflare-csam';
  labels: string[];
  confidence?: number;
  raw?: unknown;
}

export interface SafetySignalAdapter {
  name: string;
  execute(input: {
    url?: string;
    buffer?: Buffer;
    mimeType?: string;
  }): Promise<SafetySignal | null>;
}

export async function runSafetyAdapters(
  adapters: SafetySignalAdapter[],
  input: {
    url?: string;
    buffer?: Buffer;
    mimeType?: string;
  }
): Promise<SafetySignal[]> {
  const results: SafetySignal[] = [];
  for (const adapter of adapters) {
    try {
      const result = await adapter.execute(input);
      if (result) results.push(result);
    } catch (err) {
      console.error(`[safety-adapter-error] ${adapter.name}`, err);
    }
  }
  return results;
}
