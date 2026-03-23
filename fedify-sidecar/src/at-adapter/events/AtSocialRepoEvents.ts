/**
 * V6.5 Phase 5: AT Social Repo Events
 *
 * Defines the canonical events and AT repo operations for social actions
 * (follow, like, repost).
 */

import { CanonicalIdentity } from '../../core-domain/events/CoreIdentityEvents';
import { CanonicalPost } from '../projection/AtProjectionPolicy';

// ---------------------------------------------------------------------------
// Canonical Social Entities
// ---------------------------------------------------------------------------

export interface CanonicalFollow {
  id: string;
  followerId: string;
  followedId: string;
  createdAt: string;
}

export interface CanonicalLike {
  id: string;
  actorId: string;
  postId: string;
  createdAt: string;
}

export interface CanonicalRepost {
  id: string;
  actorId: string;
  postId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Canonical Social Events
// ---------------------------------------------------------------------------

export interface CoreFollowCreatedV1 {
  follow: CanonicalFollow;
  follower: CanonicalIdentity;
  followed: CanonicalIdentity;
  emittedAt: string;
}

export interface CoreFollowDeletedV1 {
  canonicalFollowId: string;
  followerCanonicalId: string;
  followedCanonicalId: string;
  deletedAt: string;
  emittedAt: string;
}

export interface CoreLikeCreatedV1 {
  like: CanonicalLike;
  actor: CanonicalIdentity;
  targetPost: CanonicalPost;
  emittedAt: string;
}

export interface CoreLikeDeletedV1 {
  canonicalLikeId: string;
  canonicalActorId: string;
  canonicalPostId: string;
  deletedAt: string;
  emittedAt: string;
}

export interface CoreRepostCreatedV1 {
  repost: CanonicalRepost;
  actor: CanonicalIdentity;
  targetPost: CanonicalPost;
  emittedAt: string;
}

export interface CoreRepostDeletedV1 {
  canonicalRepostId: string;
  canonicalActorId: string;
  canonicalPostId: string;
  deletedAt: string;
  emittedAt: string;
}

// ---------------------------------------------------------------------------
// AT Repo Social Operations
// ---------------------------------------------------------------------------

export type AtSocialCollection =
  | 'app.bsky.graph.follow'
  | 'app.bsky.feed.like'
  | 'app.bsky.feed.repost';

export interface AtSocialRepoOpV1 {
  did: string;
  canonicalAccountId: string;
  opId: string;
  opType: 'create' | 'delete';
  collection: AtSocialCollection;
  rkey: string;
  canonicalRefId: string;
  record: unknown | null;
  emittedAt: string;
}
