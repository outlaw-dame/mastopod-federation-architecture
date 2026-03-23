/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * Event contracts for the search indexing pipeline.
 */

/**
 * search.public.upsert.v1
 *
 * Emitted by protocol-specific projectors (ApSearchProjector, AtSearchProjector)
 * to request an upsert into the unified OpenSearch index.
 */
export interface SearchPublicUpsertV1 {
  upsertKind: 'full' | 'partial';
  stableDocId: string;
  canonicalContentId?: string;

  protocolSource: 'ap' | 'at';
  sourceKind: 'local' | 'remote';

  ap?: {
    objectUri: string;
    activityUri?: string;
  };

  at?: {
    uri: string;
    cid?: string;
    did: string;
  };

  author: {
    canonicalId?: string;
    apUri?: string;
    did?: string;
    handle?: string;
  };

  content: {
    text: string;
    createdAt: string;
    langs?: string[];
    tags?: string[];
  };

  relations?: {
    replyToStableId?: string;
    quoteOfStableId?: string;
  };

  media?: {
    hasMedia: boolean;
    mediaCount: number;
  };

  indexedAt: string;
}

/**
 * search.public.partial_update.v1
 *
 * Emitted for engagement counters, author patches, etc.
 */
export interface SearchPublicPartialUpdateV1 {
  stableDocId: string;
  updateKind: 'engagement_delta' | 'author_patch' | 'protocol_alias_patch';
  deltas?: {
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
  };
  partialFields?: Record<string, unknown>;
  indexedAt: string;
}

/**
 * search.public.delete.v1
 *
 * Emitted by protocol-specific projectors when content is deleted or tombstoned.
 */
export interface SearchPublicDeleteV1 {
  stableDocId: string;
  reason:
    | 'ap_tombstone'
    | 'at_delete'
    | 'moderation'
    | 'account_deactivated';
  deleteMode: 'soft' | 'hard';
  deletedAt: string;
}

/**
 * search.author.upsert.v1
 */
export interface SearchAuthorUpsertV1 {
  stableAuthorId: string;
  canonicalAccountId?: string;
  protocolSource: 'ap' | 'at';
  sourceKind: 'local' | 'remote';
  apUri?: string;
  did?: string;
  handle?: string;
  displayName?: string;
  summaryText?: string;
  labels?: string[];
  langs?: string[];
  updatedAt: string;
}

/**
 * search.author.delete.v1
 */
export interface SearchAuthorDeleteV1 {
  stableAuthorId: string;
  reason: 'ap_tombstone' | 'at_delete' | 'moderation' | 'account_deactivated';
  deleteMode: 'soft' | 'hard';
  deletedAt: string;
}
