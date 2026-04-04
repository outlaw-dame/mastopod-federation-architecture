import { UserSafetyPreferences } from '../preferences/safetyPreferences.js';
import { MediaPresentationMetadata } from './presentationTypes.js';

export function resolvePresentationPolicy(params: {
  metadata: MediaPresentationMetadata;
  prefs: UserSafetyPreferences;
}) {
  const { metadata, prefs } = params;

  let hideMedia = metadata.isSensitive && !prefs.autoRevealSensitiveMedia;

  if (prefs.hideGraphicViolence && metadata.contentWarning === 'Graphic content') {
    hideMedia = true;
  }

  if (prefs.hideSexualContent && metadata.contentWarning === 'Sensitive content') {
    hideMedia = true;
  }

  return {
    ...metadata,
    hideMediaByDefault: hideMedia
  };
}
