export interface UserSafetyPreferences {
  autoRevealSensitiveMedia: boolean;
  showContentWarningsByDefault: boolean;
  hideGraphicViolence: boolean;
  hideSexualContent: boolean;
  hideUnlabeledSensitiveMedia: boolean;
  preferredBlurMode: 'blur' | 'placeholder';
}

export const DefaultUserSafetyPreferences: UserSafetyPreferences = {
  autoRevealSensitiveMedia: false,
  showContentWarningsByDefault: false,
  hideGraphicViolence: true,
  hideSexualContent: true,
  hideUnlabeledSensitiveMedia: false,
  preferredBlurMode: 'blur'
};

export function mergeSafetyPreferences(
  base: UserSafetyPreferences,
  patch: Partial<UserSafetyPreferences>
): UserSafetyPreferences {
  return {
    ...base,
    ...patch
  };
}
