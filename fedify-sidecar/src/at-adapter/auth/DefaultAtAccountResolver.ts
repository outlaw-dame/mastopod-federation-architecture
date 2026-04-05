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
import type { AtAccountResolver, ResolvedAtAccount } from './AtSessionTypes.js';
import type { IdentityBindingSyncService } from '../identity/IdentityBindingSyncService.js';
import { traceIdentitySync, type IdentitySyncLogger } from '../identity/IdentitySyncTrace.js';

export class DefaultAtAccountResolver implements AtAccountResolver {
  constructor(
    private readonly identityRepo: IdentityBindingRepository,
    private readonly identityBindingSyncService?: IdentityBindingSyncService,
    private readonly logger?: IdentitySyncLogger
  ) {}

  async resolveByIdentifier(
    identifier: string
  ): Promise<ResolvedAtAccount | null> {
    if (!identifier?.trim()) return null;

    const id = identifier.trim();
    traceIdentitySync(this.logger, 'debug', 'resolver:resolveByIdentifier:start', {
      identifier: id,
    });

    let binding = await this.resolveLocally(id);

    if (binding) {
      const resolved = this.toResolved(binding);
      if (resolved) {
        traceIdentitySync(this.logger, 'info', 'resolver:local-hit', {
          identifier: id,
          canonicalAccountId: resolved.canonicalAccountId,
          did: resolved.did,
          handle: resolved.handle,
        });
        return resolved;
      }
    }

    traceIdentitySync(this.logger, 'debug', 'resolver:local-miss', {
      identifier: id,
    });

    if (!binding && this.identityBindingSyncService) {
      const synced = await this.syncOnMiss(id);
      traceIdentitySync(this.logger, 'debug', 'resolver:sync-result', {
        identifier: id,
        synced,
      });

      if (synced) {
        traceIdentitySync(this.logger, 'debug', 'resolver:retry-local-lookup', {
          identifier: id,
        });
        binding = await this.resolveLocally(id);

        if (binding) {
          const resolved = this.toResolved(binding);
          if (resolved) {
            traceIdentitySync(this.logger, 'info', 'resolver:retry-hit', {
              identifier: id,
              canonicalAccountId: resolved.canonicalAccountId,
              did: resolved.did,
              handle: resolved.handle,
            });
            return resolved;
          }
        }

        traceIdentitySync(this.logger, 'warn', 'resolver:retry-still-miss', {
          identifier: id,
        });
      }
    }

    traceIdentitySync(this.logger, 'warn', 'resolver:not-found', {
      identifier: id,
    });

    return null;
  }

  async resolveByCanonicalAccountId(
    canonicalAccountId: string
  ): Promise<ResolvedAtAccount | null> {
    traceIdentitySync(this.logger, 'debug', 'resolver:resolveByCanonicalAccountId:start', {
      canonicalAccountId,
    });

    let binding = await this.identityRepo.getByCanonicalAccountId(canonicalAccountId);

    if (!binding && this.identityBindingSyncService) {
      traceIdentitySync(this.logger, 'debug', 'resolver:canonical-local-miss', {
        canonicalAccountId,
      });

      const synced = await this.identityBindingSyncService.syncByCanonicalAccountId(canonicalAccountId);
      traceIdentitySync(this.logger, 'debug', 'resolver:canonical-sync-result', {
        canonicalAccountId,
        synced,
      });

      if (synced) {
        traceIdentitySync(this.logger, 'debug', 'resolver:canonical-retry-local-lookup', {
          canonicalAccountId,
        });
        binding = await this.identityRepo.getByCanonicalAccountId(canonicalAccountId);
      }
    }

    if (!binding) {
      traceIdentitySync(this.logger, 'warn', 'resolver:canonical-not-found', {
        canonicalAccountId,
      });
      return null;
    }

    const resolved = this.toResolved(binding);
    if (!resolved) {
      traceIdentitySync(this.logger, 'warn', 'resolver:canonical-not-resolvable', {
        canonicalAccountId,
        status: binding.status,
        did: binding.atprotoDid,
        handle: binding.atprotoHandle,
      });
      return null;
    }

    traceIdentitySync(this.logger, 'info', 'resolver:canonical-hit', {
      canonicalAccountId,
      did: resolved.did,
      handle: resolved.handle,
    });

    return resolved;
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

  private toResolved(
    binding: {
      canonicalAccountId: string;
      webId: string;
      atprotoDid: string | null;
      atprotoHandle: string | null;
      atprotoPdsEndpoint?: string | null;
      atprotoManaged?: boolean;
      atprotoSource?: 'local' | 'external';
      status: 'active' | 'suspended' | 'deactivated' | 'pending';
    } | null
  ): ResolvedAtAccount | null {
    if (!binding) return null;
    if (binding.status !== 'active') return null;
    if (!binding.atprotoDid || !binding.atprotoHandle) return null;

    const atprotoSource = binding.atprotoSource ?? 'local';
    const atprotoManaged =
      typeof binding.atprotoManaged === 'boolean'
        ? binding.atprotoManaged
        : atprotoSource !== 'external';
    const atprotoPdsUrl = binding.atprotoPdsEndpoint ?? null;

    if (!atprotoManaged && !atprotoPdsUrl) {
      return null;
    }

    return {
      canonicalAccountId: binding.canonicalAccountId,
      webId: binding.webId,
      did: binding.atprotoDid,
      handle: binding.atprotoHandle,
      status: binding.status,
      atprotoManaged,
      atprotoSource,
      atprotoPdsUrl,
    };
  }
}
