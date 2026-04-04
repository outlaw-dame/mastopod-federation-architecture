import { UserSafetyPreferences } from '../preferences/safetyPreferences.js';

export interface FeedItem {
  id: string;
  labels?: string[];
  hasContentWarning?: boolean;
}

export function filterFeedItems(params: {
  items: FeedItem[];
  prefs: UserSafetyPreferences;
}): FeedItem[] {
  return params.items.filter(item => {
    const labels = item.labels || [];

    if (params.prefs.hideGraphicViolence && labels.includes('graphic-media')) {
      return false;
    }

    if (params.prefs.hideSexualContent && labels.includes('nsfw')) {
      return false;
    }

    if (params.prefs.hideUnlabeledSensitiveMedia && item.hasContentWarning === false && labels.length === 0) {
      return false;
    }

    return true;
  });
}
