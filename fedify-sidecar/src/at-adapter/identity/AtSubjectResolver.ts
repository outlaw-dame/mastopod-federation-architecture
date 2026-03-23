/**
 * V6.5 Phase 5: AT Subject Resolver
 *
 * Resolves canonical identities to ATProto DIDs for follow targets.
 */

import { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository';
import { IdentityBinding } from '../../core-domain/identity/IdentityBinding';

export interface AtSubjectResolver {
  resolveDidForCanonicalAccount(canonicalAccountId: string): Promise<string | null>;
  resolveDidForIdentity(identity: any): Promise<string | null>;
}

export class DefaultAtSubjectResolver implements AtSubjectResolver {
  constructor(private readonly identityRepo: IdentityBindingRepository) {}

  async resolveDidForCanonicalAccount(canonicalAccountId: string): Promise<string | null> {
    const binding = await this.identityRepo.getByCanonicalAccountId(canonicalAccountId);
    if (binding && binding.status === 'active' && binding.atprotoDid) {
      return binding.atprotoDid;
    }
    return null;
  }

  async resolveDidForIdentity(identity: any): Promise<string | null> {
    // 1. Try local binding first
    const did = await this.resolveDidForCanonicalAccount(identity.id);
    if (did) return did;

    // 2. If target is remote and canonical identity already stores a DID, use it
    // (Assuming CanonicalIdentity might have a known AT DID in a real implementation)
    // For Phase 5, we only support local-to-local or explicitly known DIDs.
    if ((identity as any).atprotoDid) {
      return (identity as any).atprotoDid;
    }

    return null;
  }
}
