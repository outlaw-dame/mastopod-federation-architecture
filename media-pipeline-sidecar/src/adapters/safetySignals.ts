import { logger } from '../logger';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
const SAFETY_SOURCES = new Set([
  'google-vision',
  'google-video',
  'safe-browsing',
  'cloudflare-csam',
  'pdq-hash',
] as const);

const MAX_SIGNAL_COUNT = 8;
const MAX_LABEL_COUNT = 16;
const MAX_LABEL_LENGTH = 64;

export interface SafetySignal {
  source: 'google-vision' | 'google-video' | 'safe-browsing' | 'cloudflare-csam' | 'pdq-hash';
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
    logger.warn({
      adapter: adapter?.name || 'unknown-adapter',
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
    }, 'safety-adapter-error');
  }
  return results.flatMap((signal) => {
    const normalized = normalizeSafetySignal(signal);
    return normalized ? [normalized] : [];
  });
}

function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, MAX_LABEL_LENGTH);
}

function sanitizeRaw(value: unknown, maxBytes: number): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      return undefined;
    }

    if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
      return JSON.parse(serialized);
    }
  } catch {
    return undefined;
  }

  return {
    truncated: true
  };
}

export function normalizeSafetySignal(signal: Partial<SafetySignal>, maxRawBytes = 2048): SafetySignal | null {
  if (!signal || typeof signal !== 'object') {
    return null;
  }

  if (typeof signal.source !== 'string' || !SAFETY_SOURCES.has(signal.source as SafetySignal['source'])) {
    return null;
  }

  const labels = [...new Set(
    (Array.isArray(signal.labels) ? signal.labels : [])
      .map((label) => sanitizeLabel(label))
      .filter((label): label is string => Boolean(label))
  )].slice(0, MAX_LABEL_COUNT);

  const normalized: SafetySignal = {
    source: signal.source as SafetySignal['source'],
    labels
  };

  if (typeof signal.confidence === 'number' && Number.isFinite(signal.confidence)) {
    normalized.confidence = Math.max(0, Math.min(1, signal.confidence));
  }

  if (signal.raw !== undefined) {
    normalized.raw = sanitizeRaw(signal.raw, maxRawBytes);
  }

  return normalized;
}

export function serializeSafetySignals(signals: SafetySignal[], maxBytes = 8192): string {
  const normalized = signals
    .flatMap((signal) => {
      const sanitized = normalizeSafetySignal(signal);
      return sanitized ? [sanitized] : [];
    })
    .slice(0, MAX_SIGNAL_COUNT);

  const withRaw = JSON.stringify(normalized);
  if (Buffer.byteLength(withRaw, 'utf8') <= maxBytes) {
    return withRaw;
  }

  const withoutRaw = normalized.map((signal) => ({
    source: signal.source,
    labels: signal.labels,
    confidence: signal.confidence
  }));

  const withoutRawJson = JSON.stringify(withoutRaw);
  if (Buffer.byteLength(withoutRawJson, 'utf8') <= maxBytes) {
    return withoutRawJson;
  }

  return JSON.stringify(withoutRaw.slice(0, Math.max(1, Math.floor(MAX_SIGNAL_COUNT / 2))));
}

export function parseSafetySignals(raw: string | undefined, maxRawBytes = 2048): SafetySignal[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .flatMap((signal) => {
        const normalized = normalizeSafetySignal(signal as Partial<SafetySignal>, maxRawBytes);
        return normalized ? [normalized] : [];
      })
      .slice(0, MAX_SIGNAL_COUNT);
  } catch {
    return [];
  }
}
