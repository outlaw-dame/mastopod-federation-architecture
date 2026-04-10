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
  const settled = await Promise.allSettled(adapters.map((adapter) => adapter.execute(input)));
  const results: SafetySignal[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      if (outcome.value) {
        results.push(outcome.value);
      }
      continue;
    }
    const adapter = adapters[i];
    console.error(`[safety-adapter-error] ${adapter?.name || 'unknown-adapter'}`, outcome.reason);
  }
  return results;
}
