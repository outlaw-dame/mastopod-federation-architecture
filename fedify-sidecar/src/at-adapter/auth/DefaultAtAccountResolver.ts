/**
 * V6.5 Phase 7: Default AT Account Resolver
 *
 * Resolves an ATProto identifier (DID or handle) to the canonical account
 * that owns it, using the IdentityBindingRepository as the authoritative
 * source of truth.
 *
 * Resolution rules:
 *   - If identifier starts with "did:" → resolve by AT DID
 *   - Otherwise → treat as AT handle and resolve by handle
 *
 * Returns null for accounts that are not provisioned on this instance or
 * that have not completed ATProto provisioning (null atprotoDid/Handle).
 */

import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { AtAccountResolver } from './AtSessionTypes.js';
import type { IdentityBindingSyncService } from '../identity/IdentityBindingSyncService.js';

export class DefaultAtAccountResolver implements AtAccountResolver {
  constructor(
    private readonly identityRepo: IdentityBindingRepository,
    private readonly identityBindingSyncService?: IdentityBindingSyncService
  ) {}

  async resolveByIdentifier(
    identifier: string
  ): Promise<{ canonicalAccountId: string; did: string; handle: string } | null> {
    if (!identifier?.trim()) return null;

    const id = identifier.trim();
    let binding = await this.resolveLocally(id);

    if (!binding && this.identityBindingSyncService) {
      const synced = await this.syncOnMiss(id);
      if (synced) {
        binding = await this.resolveLocally(id);
      }
    }

    if (!binding) return null;

    // Account must be active and fully provisioned on the ATProto side
    if (binding.status !== 'active') return null;
    if (!binding.atprotoDid || !binding.atprotoHandle) return null;

    return {
      canonicalAccountId: binding.canonicalAccountId,
      did:    binding.atprotoDid,
      handle: binding.atprotoHandle,
    };
  }

  private async resolveLocally(identifier: string) {
    if (identifier.startsWith('did:')) {
      return this.identityRepo.getByAtprotoDid(identifier);
    }

    if (identifier.startsWith('http://') || identifier.startsWith('https://')) {
      return this.identityRepo.getByCanonicalAccountId(identifier);
    }

    return this.identityRepo.getByAtprotoHandle(identifier);
  }

  private async syncOnMiss(identifier: string): Promise<boolean> {
    if (!this.identityBindingSyncService) return false;

    if (identifier.startsWith('did:')) {
      return this.identityBindingSyncService.syncByDid(identifier);
    }

    if (identifier.startsWith('http://') || identifier.startsWith('https://')) {
      return this.identityBindingSyncService.syncByCanonicalAccountId(identifier);
    }

    return this.identityBindingSyncService.syncByHandle(identifier);
  }
}
