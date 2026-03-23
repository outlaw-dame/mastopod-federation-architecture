/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * OpenSearch Document Model for the unified public-content-v1 index.
 */

export interface PublicContentDocument {
  stableDocId: string;
  canonicalContentId?: string;

  protocolPresence: Array<'ap' | 'at'>;
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

  text: string;
  createdAt: string;
  langs?: string[];
  tags?: string[];

  replyToStableId?: string;
  quoteOfStableId?: string;

  hasMedia: boolean;
  mediaCount: number;

  isDeleted: boolean;
  indexedAt: string;
}
