import { IdentityBinding } from '../../../core-domain/identity/IdentityBinding';
import { CanonicalProfile } from '../AtProjectionPolicy';

export interface AppBskyActorProfileRecord {
  $type: 'app.bsky.actor.profile';
  displayName?: string;
  description?: string;
  avatar?: unknown;
  banner?: unknown;
}

export interface ProfileRecordSerializer {
  serialize(
    profile: CanonicalProfile,
    binding: IdentityBinding,
    mediaResolver: ProfileMediaResolver
  ): Promise<AppBskyActorProfileRecord>;
}

export interface ProfileMediaResolver {
  resolveAvatarBlob(mediaId: string): Promise<unknown | null>;
  resolveBannerBlob(mediaId: string): Promise<unknown | null>;
}

export class DefaultProfileRecordSerializer implements ProfileRecordSerializer {
  async serialize(
    profile: CanonicalProfile,
    binding: IdentityBinding,
    mediaResolver: ProfileMediaResolver
  ): Promise<AppBskyActorProfileRecord> {
    const record: AppBskyActorProfileRecord = {
      $type: 'app.bsky.actor.profile',
    };

    if (profile.displayName) record.displayName = profile.displayName;
    if (profile.summaryPlaintext) record.description = profile.summaryPlaintext;

    if (profile.avatarMediaId) {
      const avatar = await mediaResolver.resolveAvatarBlob(profile.avatarMediaId);
      if (avatar) record.avatar = avatar;
    }

    if (profile.bannerMediaId) {
      const banner = await mediaResolver.resolveBannerBlob(profile.bannerMediaId);
      if (banner) record.banner = banner;
    }

    return record;
  }
}
