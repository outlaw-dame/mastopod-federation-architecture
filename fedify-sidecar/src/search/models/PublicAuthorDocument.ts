/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * OpenSearch Document Model for the unified public-author-v1 index.
 */

export interface PublicAuthorDocument {
  stableAuthorId: string;             // canonicalAccountId if local
  canonicalAccountId?: string;

  apUri?: string;
  did?: string;
  handle?: string;

  displayName?: string;
  summaryText?: string;
  labels?: string[];
  langs?: string[];
  searchConsentPublic?: boolean;
  searchConsentExplicit?: boolean;
  searchConsentSource?: "actor_searchableBy" | "actor_indexable" | "none";
  searchableBy?: string[];
  indexable?: boolean;

  protocolPresence: Array<'ap' | 'at'>;
  sourceKind: 'local' | 'remote';

  updatedAt: string;
}
