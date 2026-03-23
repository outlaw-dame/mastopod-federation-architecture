/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * SearchDedupService
 * Handles deterministic local merge and conservative remote merge logic.
 */

import { SearchPublicUpsertV1 } from '../events/SearchEvents';
import { PublicContentDocument } from '../models/PublicContentDocument';
import { SearchDocAliasCache } from '../writer/SearchDocAliasCache';

export interface SearchDedupService {
  resolveStableDocId(input: SearchPublicUpsertV1): Promise<string>;
  shouldMergeRemoteDuplicate(
    existing: PublicContentDocument,
    incoming: SearchPublicUpsertV1
  ): Promise<boolean>;
}

export class DefaultSearchDedupService implements SearchDedupService {
  constructor(private readonly aliasCache: SearchDocAliasCache) {}

  async resolveStableDocId(input: SearchPublicUpsertV1): Promise<string> {
    // Rule 1: Local content ALWAYS uses canonicalContentId if available
    if (input.canonicalContentId) {
      const cached = await this.aliasCache.getByCanonicalId(input.canonicalContentId);
      if (cached) return cached;
      return input.canonicalContentId;
    }

    // Rule 2: Remote content checks cache first
    if (input.ap?.objectUri) {
      const cached = await this.aliasCache.getByApUri(input.ap.objectUri);
      if (cached) return cached;
    }

    if (input.at?.uri) {
      const cached = await this.aliasCache.getByAtUri(input.at.uri);
      if (cached) return cached;
    }

    // Rule 3: Fallback to the provided stableDocId (which should be ap:uri or at:uri)
    return input.stableDocId;
  }

  async shouldMergeRemoteDuplicate(
    existing: PublicContentDocument,
    incoming: SearchPublicUpsertV1
  ): Promise<boolean> {
    // If they share a canonical ID, it's a deterministic merge (local)
    if (existing.canonicalContentId && incoming.canonicalContentId && 
        existing.canonicalContentId === incoming.canonicalContentId) {
      return true;
    }

    // If one is local and the other is remote, but they don't share a canonical ID,
    // we should be very careful. Usually we don't merge unless we have strong proof.
    if (existing.sourceKind !== incoming.sourceKind) {
      return false;
    }

    // Conservative remote merge rules:
    // 1. Must have verified linked identity (same canonical author ID)
    if (!existing.author.canonicalId || !incoming.author.canonicalId || 
        existing.author.canonicalId !== incoming.author.canonicalId) {
      return false;
    }

    // 2. Texts must be identical or near-identical
    // For Phase 5.5, we require exact match or one being a substring of the other
    // (e.g. due to truncation or different HTML stripping)
    const t1 = existing.text.trim();
    const t2 = incoming.content.text.trim();
    if (t1 !== t2 && !t1.includes(t2) && !t2.includes(t1)) {
      return false;
    }

    // 3. Timestamps within tolerance (e.g., 5 minutes)
    const d1 = new Date(existing.createdAt).getTime();
    const d2 = new Date(incoming.content.createdAt).getTime();
    if (Math.abs(d1 - d2) > 5 * 60 * 1000) {
      return false;
    }

    // 4. Reply/quote relationships do not conflict
    if (existing.replyToStableId && incoming.relations?.replyToStableId && 
        existing.replyToStableId !== incoming.relations.replyToStableId) {
      return false;
    }

    if (existing.quoteOfStableId && incoming.relations?.quoteOfStableId && 
        existing.quoteOfStableId !== incoming.relations.quoteOfStableId) {
      return false;
    }

    return true;
  }
}
