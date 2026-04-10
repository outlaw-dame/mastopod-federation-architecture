/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * Shared dependency used by both projectors and index writer.
 * Maps canonicalId <-> AP URI <-> AT DID/URI.
 */

import { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';

export interface ResolvedIdentity {
  canonicalId?: string;
  apUri?: string;
  atDid?: string;
  atHandle?: string;
}

export interface IdentityAliasResolver {
  /**
   * Resolve identity by Canonical ID
   */
  resolveByCanonicalId(canonicalId: string): Promise<ResolvedIdentity>;

  /**
   * Resolve identity by ActivityPub Actor URI
   */
  resolveByApUri(apUri: string): Promise<ResolvedIdentity>;

  /**
   * Resolve identity by ATProto DID
   */
  resolveByAtDid(did: string): Promise<ResolvedIdentity>;
}

export class DefaultIdentityAliasResolver implements IdentityAliasResolver {
  constructor(private readonly identityRepo: IdentityBindingRepository) {}

  async resolveByCanonicalId(canonicalId: string): Promise<ResolvedIdentity> {
    const binding = await this.identityRepo.getByCanonicalAccountId(canonicalId);
    if (!binding) {
      return { canonicalId };
    }

    return {
      canonicalId: binding.canonicalAccountId,
      apUri: binding.activityPubActorUri,
      atDid: binding.atprotoDid || undefined,
      atHandle: binding.atprotoHandle || undefined,
    };
  }

  async resolveByApUri(apUri: string): Promise<ResolvedIdentity> {
    // Note: In a real implementation, IdentityBindingRepository would need a getByApUri method.
    // For Phase 5.25, we assume we can resolve it or we just return the AP URI.
    // We'll simulate it by checking if we can find it, otherwise return just the AP URI.
    
    // Fallback linear scan for simulation (in production, use an index)
    const allBindings = await this.identityRepo.listByStatus('active', 1000, 0);
    const binding = allBindings.find(b => b.activityPubActorUri === apUri);
    
    if (!binding) {
      return { apUri };
    }

    return {
      canonicalId: binding.canonicalAccountId,
      apUri: binding.activityPubActorUri,
      atDid: binding.atprotoDid || undefined,
      atHandle: binding.atprotoHandle || undefined,
    };
  }

  async resolveByAtDid(did: string): Promise<ResolvedIdentity> {
    // Fallback linear scan for simulation (in production, use an index)
    const allBindings = await this.identityRepo.listByStatus('active', 1000, 0);
    const binding = allBindings.find(b => b.atprotoDid === did);
    
    if (!binding) {
      return { atDid: did };
    }

    return {
      canonicalId: binding.canonicalAccountId,
      apUri: binding.activityPubActorUri,
      atDid: binding.atprotoDid || undefined,
      atHandle: binding.atprotoHandle || undefined,
    };
  }
}
