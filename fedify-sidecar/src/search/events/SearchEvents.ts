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
  deletedAt: string;
}
