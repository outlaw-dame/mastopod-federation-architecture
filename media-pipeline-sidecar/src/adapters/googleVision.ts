import { SafetySignalAdapter } from './safetySignals';

export class GoogleVisionAdapter implements SafetySignalAdapter {
  name = 'google-vision';

  async execute({ buffer }: { buffer?: Buffer }) {
    if (!buffer) return null;

    const result = await detectSafeSearch(buffer as Buffer);

    return {
      source: 'google-vision',
      labels: mapVisionToLabels(result),
      confidence: extractConfidence(result),
      raw: result
    };
  }
}
