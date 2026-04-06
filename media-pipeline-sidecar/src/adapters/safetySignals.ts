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

// NOTE:
// These adapters MUST NOT make final moderation decisions.
// They only return signals for downstream MRF evaluation.

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
      const res = await adapter.execute(input);
      if (res) results.push(res);
    } catch (err) {
      // Fail open: signal collection must not block pipeline
      console.error(`[safety-adapter-error] ${adapter.name}`, err);
    }
  }

  return results;
}
