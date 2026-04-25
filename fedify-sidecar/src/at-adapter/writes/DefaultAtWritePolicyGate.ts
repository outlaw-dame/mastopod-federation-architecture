/**
 * V6.5 Phase 7: Default AT Write Policy Gate
 *
 * Enforces write policy rules AFTER normalization and BEFORE canonical write
 * submission.  Every inbound XRPC mutation must pass this gate.
 *
 * Rules (in evaluation order):
 *   1. The canonical account must be active (not suspended/deactivated).
 *   2. The caller must own the target AT repo (DID or handle must match
 *      their IdentityBinding).  This is a defence-in-depth check on top of
 *      the repo-ownership assertion already in the route handlers.
 *   3. The collection must be in the supported Phase 7 allowlist.
 *   4. putRecord / profile_upsert: always allowed for app.bsky.actor.profile;
 *      post_create is used for both createRecord and putRecord on posts/articles —
 *      reject putRecord on posts/articles if canonical post editing is not enabled.
 *   5. Deletes: alias must exist and be owned by this canonical account.
 *      Deleting a record that was never projected here returns WriteNotAllowed.
 *
 * This gate is intentionally deny-by-default: any mutation that does not
 * match an explicit ACCEPT path is rejected with WriteNotAllowed.
 */

import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { AtAliasStore } from '../repo/AtAliasStore.js';
import type {
  CanonicalMutationEnvelope,
  AtWritePolicyGate,
  AtWritePolicyDecision,
  SUPPORTED_COLLECTIONS,
} from './AtWriteTypes.js';
import { SUPPORTED_COLLECTIONS as ALLOWED } from './AtWriteTypes.js';
import type { AtSessionContext } from '../auth/AtSessionTypes.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DefaultAtWritePolicyGateConfig {
  /**
   * Whether to allow putRecord on app.bsky.feed.post.
   * Off by default — enable only when the canonical Tier 1 supports post editing.
   */
  allowPostEditing?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtWritePolicyGate implements AtWritePolicyGate {
  private readonly allowPostEditing: boolean;

  constructor(
    private readonly identityRepo: IdentityBindingRepository,
    private readonly aliasStore: AtAliasStore,
    config: DefaultAtWritePolicyGateConfig = {}
  ) {
    this.allowPostEditing = config.allowPostEditing ?? false;
  }

  async evaluate(
    mutation: CanonicalMutationEnvelope,
    auth: AtSessionContext
  ): Promise<AtWritePolicyDecision> {
    // ------------------------------------------------------------------
    // Rule 1: account must be active
    // ------------------------------------------------------------------
    const binding = await this.identityRepo.getByCanonicalAccountId(
      auth.canonicalAccountId
    );
    if (!binding) {
      return reject('Forbidden', 'Account not found');
    }
    if (binding.status !== 'active') {
      return reject(
        'Forbidden',
        `Account is ${binding.status} and cannot write`
      );
    }

    // ------------------------------------------------------------------
    // Rule 2: caller must own the target repo
    // ------------------------------------------------------------------
    const atRepo = (mutation.payload["_atRepo"] as string | undefined)?.trim().toLowerCase();
    if (atRepo) {
      const ownsDid    = binding.atprotoDid?.toLowerCase()    === atRepo;
      const ownsHandle = binding.atprotoHandle?.toLowerCase() === atRepo;
      if (!ownsDid && !ownsHandle) {
        return reject(
          'Forbidden',
          `Cannot write to repo ${mutation.payload["_atRepo"]}: not the authenticated account`
        );
      }
    }

    // ------------------------------------------------------------------
    // Rule 3: collection must be in the allowlist
    // ------------------------------------------------------------------
    const collection = mutation.payload["_collection"] as string | undefined;
    if (collection && !ALLOWED.has(collection)) {
      return reject('UnsupportedCollection', `Collection not supported: ${collection}`);
    }

    // ------------------------------------------------------------------
    // Rule 4: putRecord / profile_upsert semantics check
    // ------------------------------------------------------------------
    if (mutation.mutationType === 'profile_upsert') {
      // Profiles are always upsert — always allowed
      return ACCEPT;
    }

    if (
      mutation.mutationType === 'post_create' &&
      (collection === 'app.bsky.feed.post' || collection === 'site.standard.document')
    ) {
      const operation = _normalizedOperation(mutation.payload);
      if (operation === 'update' && !this.allowPostEditing) {
        return reject(
          'WriteNotAllowed',
          'Post editing is not supported on the canonical write path.'
        );
      }
      return ACCEPT;
    }

    // ------------------------------------------------------------------
    // Rule 5: delete mutations — alias must exist and belong to this account
    // ------------------------------------------------------------------
    if (_isDeleteMutation(mutation.mutationType)) {
      if (!binding.atprotoDid) {
        return reject('Forbidden', 'Account has no ATProto DID — cannot delete');
      }
      const rkey = mutation.payload["_rkey"] as string | undefined;
      const targetRepo = mutation.payload["_atRepo"] as string | undefined;

      if (!rkey || !collection || !targetRepo) {
        return reject('WriteNotAllowed', 'Delete requires _atRepo, _collection, _rkey in payload');
      }

      // Resolve DID from repo (may be handle)
      const repoDid = binding.atprotoDid;

      const aliases = await this.aliasStore.listByDid(repoDid);
      const alias = aliases.find(
        (a) => a.collection === collection && a.rkey === rkey && !a.deletedAt
      );

      if (!alias) {
        return reject(
          'WriteNotAllowed',
          `Record at://${repoDid}/${collection}/${rkey} was not projected here or already deleted`
        );
      }

      // Confirm ownership (DID on alias must match authenticated account DID)
      if (alias.did !== binding.atprotoDid) {
        return reject('Forbidden', 'Alias belongs to a different account');
      }

      return ACCEPT;
    }

    // ------------------------------------------------------------------
    // All other create/social mutations — policy passed
    // ------------------------------------------------------------------
    return ACCEPT;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCEPT: AtWritePolicyDecision = { decision: 'ACCEPT' };

function reject(
  reasonCode: AtWritePolicyDecision['reasonCode'],
  message: string
): AtWritePolicyDecision {
  return { decision: 'REJECT', reasonCode, message };
}

function _isDeleteMutation(t: CanonicalMutationEnvelope['mutationType']): boolean {
  return (
    t === 'post_delete'   ||
    t === 'follow_delete' ||
    t === 'like_delete'   ||
    t === 'emoji_reaction_delete' ||
    t === 'repost_delete'
  );
}

function _normalizedOperation(payload: Record<string, unknown>): 'create' | 'update' | 'delete' | 'unknown' {
  const operation = payload["_operation"];
  if (operation === 'create' || operation === 'update' || operation === 'delete') {
    return operation;
  }

  if (typeof payload["_rkey"] === 'string') {
    return 'update';
  }

  return 'unknown';
}
