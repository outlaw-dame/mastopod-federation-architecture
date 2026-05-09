import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import { ACTIVITYPODS_STORY_MAX_TTL_MS } from '../lexicon/ActivityPodsStoryLexicon.js';

// Mocking CanonicalProfile and CanonicalPost since they might not exist yet
export interface CanonicalProfile {
  id: string;
  displayName?: string;
  summaryPlaintext?: string;
  avatarBlobRef?: unknown;
  bannerBlobRef?: unknown;
  avatarMediaId?: string;
  bannerMediaId?: string;
}

export interface CanonicalPost {
  id: string;
  authorId: string;
  kind?: 'note' | 'article';
  title?: string;
  summaryPlaintext?: string;
  bodyPlaintext: string;
  canonicalUrl?: string;
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
  publishedAt: string;
  deletedAt?: string;
  replyToCanonicalPostId?: string;
  attachments?: Array<{
    kind: 'image' | 'video' | 'audio' | 'document';
    mediaId: string;
    altText?: string;
    width?: number;
    height?: number;
  }>;
}

export interface CanonicalStory {
  id: string;
  authorId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AtProjectionDecision {
  allowed: boolean;
  reason?: string;
}

export interface AtProjectionPolicy {
  canProjectProfile(profile: CanonicalProfile, binding: IdentityBinding): AtProjectionDecision;
  canProjectPost(post: CanonicalPost, binding: IdentityBinding): AtProjectionDecision;
  canProjectStory(story: CanonicalStory, binding: IdentityBinding): AtProjectionDecision;
  canProjectSocialAction(binding: IdentityBinding): AtProjectionDecision;
}

export class DefaultAtProjectionPolicy implements AtProjectionPolicy {
  canProjectProfile(profile: CanonicalProfile, binding: IdentityBinding): AtProjectionDecision {
    if (!binding.atprotoDid || !binding.atprotoHandle) {
      return { allowed: false, reason: 'missing_atproto_identity' };
    }
    if (binding.status !== 'active') {
      return { allowed: false, reason: 'identity_not_active' };
    }
    return { allowed: true };
  }

  canProjectPost(post: CanonicalPost, binding: IdentityBinding): AtProjectionDecision {
    if (!binding.atprotoDid || !binding.atprotoHandle) {
      return { allowed: false, reason: 'missing_atproto_identity' };
    }
    if (binding.status !== 'active') {
      return { allowed: false, reason: 'identity_not_active' };
    }
    if (post.visibility !== 'public') {
      return { allowed: false, reason: 'non_public_not_supported_in_phase3' };
    }
    if (post.deletedAt) {
      return { allowed: true };
    }
    return { allowed: true };
  }

  canProjectStory(story: CanonicalStory, binding: IdentityBinding): AtProjectionDecision {
    if (!binding.atprotoDid || !binding.atprotoHandle) {
      return { allowed: false, reason: 'missing_atproto_identity' };
    }
    if (binding.status !== 'active') {
      return { allowed: false, reason: 'identity_not_active' };
    }
    const createdAt = Date.parse(story.createdAt);
    const expiresAt = Date.parse(story.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
      return { allowed: false, reason: 'invalid_story_timestamps' };
    }
    if (expiresAt <= Date.now()) {
      return { allowed: false, reason: 'story_expired' };
    }
    if (expiresAt - createdAt <= 0 || expiresAt - createdAt > ACTIVITYPODS_STORY_MAX_TTL_MS) {
      return { allowed: false, reason: 'story_ttl_out_of_bounds' };
    }
    return { allowed: true };
  }

  canProjectSocialAction(binding: IdentityBinding): AtProjectionDecision {
    if (!binding.atprotoDid || !binding.atprotoHandle) {
      return { allowed: false, reason: 'missing_atproto_identity' };
    }
    if (binding.status !== 'active') {
      return { allowed: false, reason: 'identity_not_active' };
    }
    return { allowed: true };
  }
}
