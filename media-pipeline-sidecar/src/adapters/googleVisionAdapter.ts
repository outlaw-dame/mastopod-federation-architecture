import { SafetySignalAdapter } from './safetySignals';

export class GoogleVisionAdapter implements SafetySignalAdapter {
  name = 'google-vision';

  async execute({ buffer }: { buffer?: Buffer }) {
    if (!buffer) return null;

    const mockResult = { adult: 0.2, violence: 0.1 };

    return {
      source: 'google-vision',
      labels: mockResult.adult > 0.5 ? ['nsfw'] : [],
      confidence: mockResult.adult,
      raw: mockResult
    };
  }
}
