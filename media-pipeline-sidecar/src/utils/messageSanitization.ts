import { Buffer } from 'node:buffer';
import { config } from '../config/config';
import { parseSafetySignals } from '../adapters/safetySignals';
import { sanitizePlaybackVariantsForLogging, sanitizeStreamingManifestsForLogging } from './playbackVariants';

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function sanitizeUrlForLogging(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function summarizeSignals(value: string): string {
  const signals = parseSafetySignals(value);
  if (signals.length === 0) {
    return '[]';
  }

  const summary = signals.map((signal) => ({
    source: signal.source,
    labels: signal.labels,
    confidence: signal.confidence
  }));

  return truncateText(JSON.stringify(summary), 256);
}

function redactFreeText(value: string): string {
  if (!value) {
    return '';
  }

  return `[redacted:${Math.min(value.length, config.dlqPayloadPreviewBytes)} chars]`;
}

export function sanitizeMessageForDlq(message: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(message)) {
    if (!value) {
      sanitized[key] = '';
      continue;
    }

    switch (key) {
      case 'sourceUrl':
      case 'canonicalUrl':
      case 'gatewayUrl':
      case 'previewUrl':
      case 'thumbnailUrl':
        sanitized[key] = sanitizeUrlForLogging(value);
        break;
      case 'playbackVariants':
        sanitized[key] = truncateText(sanitizePlaybackVariantsForLogging(value), 256);
        break;
      case 'streamingManifests':
        sanitized[key] = truncateText(sanitizeStreamingManifestsForLogging(value), 256);
        break;
      case 'alt':
      case 'contentWarning':
        sanitized[key] = redactFreeText(value);
        break;
      case 'signals':
        sanitized[key] = summarizeSignals(value);
        break;
      case 'bytesBase64':
        sanitized[key] = `[redacted:${Buffer.byteLength(value, 'utf8')} bytes]`;
        break;
      default:
        sanitized[key] = truncateText(value, 256);
        break;
    }
  }

  return sanitized;
}
