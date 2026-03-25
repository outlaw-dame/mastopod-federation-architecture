/**
 * V6.5 Phase 7: Default AT Write Alias Resolver
 *
 * Resolves an AT record (DID + collection + rkey) to its canonical object,
 * enabling the write path to find what to delete when the caller provides
 * AT repo coordinates rather than a canonical ID.
 *
 * Implementation: O(n) scan over aliases for the target DID.  Acceptable
 * for single-process Phase 7; replace with an indexed Redis reverse-lookup
 * (key: at:alias:at:{did}/{collection}/{rkey} → canonicalRefId) for
 * production.
 */

import type { AtAliasStore } from '../repo/AtAliasStore.js';
import type { AtWriteAliasResolver } from './AtWriteTypes.js';

export class DefaultAtWriteAliasResolver implements AtWriteAliasResolver {
  constructor(private readonly aliasStore: AtAliasStore) {}

  async resolveCanonicalFromAtRecord(
    repoDid: string,
    collection: string,
    rkey: string
  ): Promise<{
    canonicalRefId: string;
    canonicalType: 'profile' | 'post' | 'follow' | 'like' | 'repost';
  } | null> {
    const aliases = await this.aliasStore.listByDid(repoDid);
    const match = aliases.find(
      (a) =>
        a.collection === collection &&
        a.rkey       === rkey        &&
        !a.deletedAt
    );
    if (!match) return null;
    return {
      canonicalRefId: match.canonicalRefId,
      canonicalType:  match.canonicalType,
    };
  }
}
