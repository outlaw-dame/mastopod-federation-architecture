/**
 * V6.5 Phase 5: AT Target Alias Resolver
 *
 * Resolves canonical post IDs to ATProto StrongRefs (URI + CID) for likes,
 * reposts, and reply threading.
 */

import type { AtAliasStore } from './AtAliasStore.js';

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface AtTargetAliasResolver {
  resolvePostStrongRef(canonicalPostId: string): Promise<StrongRef | null>;
}

export class DefaultAtTargetAliasResolver implements AtTargetAliasResolver {
  constructor(private readonly aliasStore: AtAliasStore) {}

  async resolvePostStrongRef(canonicalPostId: string): Promise<StrongRef | null> {
    const alias = await this.aliasStore.getByCanonicalRefId(canonicalPostId);
    
    if (!alias) return null;
    if (alias.canonicalType !== 'post') return null;
    if (alias.deletedAt) return null;
    
    // Both URI and CID are required for a valid StrongRef
    if (!alias.atUri || !alias.cid) return null;

    return {
      uri: alias.atUri,
      cid: alias.cid
    };
  }
}
