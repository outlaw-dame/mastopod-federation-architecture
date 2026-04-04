import { analyzeImageWithGoogleVision } from './googleVisionClient.js';
import { ModerationOutcome } from './moderationTypes.js';

export async function moderateImage(params: {
  base64: string;
  googleApiKey?: string;
}): Promise<ModerationOutcome<any>> {
  const reasons: string[] = [];
  const signals: any = {};

  if (params.googleApiKey) {
    const vision = await analyzeImageWithGoogleVision({
      base64Image: params.base64,
      apiKey: params.googleApiKey
    });

    signals.googleVision = vision;

    if (vision?.adult === 'VERY_LIKELY' || vision?.violence === 'VERY_LIKELY') {
      reasons.push('google_vision_block');
      return { decision: 'block', reasons, signals };
    }

    if (vision?.adult === 'LIKELY' || vision?.racy === 'LIKELY') {
      reasons.push('google_vision_review');
      return { decision: 'review', reasons, signals };
    }
  }

  return { decision: 'allow', reasons, signals };
}
