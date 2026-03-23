/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * OpenSearch Document Model for the unified public-content-v1 index.
 */

export interface PublicContentDocument {
  stableDocId: string;                // canonicalContentId for local content
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
    displayName?: string;
  };

  text: string;                       // normalized plaintext
  textRaw?: string;                   // optional for debugging only
  createdAt: string;
  updatedAt?: string;
  langs?: string[];
  tags?: string[];

  replyToStableId?: string;
  quoteOfStableId?: string;

  hasMedia: boolean;
  mediaCount: number;

  engagement?: {
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
  };

  ranking?: {
    recencyBucket?: string;
    localAffinityScore?: number;
    graphAffinityScore?: number;
    qualityScore?: number;
  };

  embedding?: number[];               // semantic vector
  isDeleted: boolean;
  indexedAt: string;
}
