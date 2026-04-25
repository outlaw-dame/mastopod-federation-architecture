/**
 * V6.5 Phase 7: com.atproto.repo.deleteRecord
 *
 * Deletes a record from a repository by repo + collection + rkey.
 *
 * Design rule: deletion is NOT performed directly on the AT repo.
 * Flow: resolve rkey → AtWriteAliasResolver → canonical object ID
 *       → CanonicalMutationEnvelope (delete) → Tier 1 canonical delete
 *       → AT projection removes the record via normal commit path.
 *
 * If the record doesn't exist or has no alias (was never projected from
 * this deployment), a 404 is returned rather than silently succeeding.
 * This matches Bluesky PDS behavior for deletes of unknown records.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-repo#comatprotorepodeleterecord
 */

import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';
import type { IdentityBindingRepository } from '../../../core-domain/identity/IdentityBindingRepository.js';
import type {
  AtDeleteRecordInput,
  AtWriteGateway,
} from '../../writes/AtWriteTypes.js';
import type { AtSessionContext } from '../../auth/AtSessionTypes.js';
import type { ExternalWriteGateway } from '../../external/ExternalWriteGateway.js';
import { isExternalAtprotoBinding } from '../../external/ExternalAccountMode.js';

/** Lexicon NSID: segments of [a-zA-Z0-9-], joined by dots, 2+ segments. */
const NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){1,}$/;

/** rkey: 1-512 chars, alphanumeric + hyphen + underscore. */
const RKEY_RE = /^[a-zA-Z0-9_-]{1,512}$/;

export class RepoDeleteRecordRoute {
  constructor(
    private readonly writeGateway: AtWriteGateway,
    private readonly identityRepo?: IdentityBindingRepository,
    private readonly externalWriteGateway?: ExternalWriteGateway
  ) {}

  async handle(
    body: Record<string, unknown> | undefined,
    auth: AtSessionContext
  ): Promise<{ headers: Record<string, string>; body: unknown }> {
    const input = this._parseInput(body);
    this._assertRepoOwnership(input.repo, auth);

    const binding = this.identityRepo
      ? await this.identityRepo.getByCanonicalAccountId(auth.canonicalAccountId)
      : null;

    if (isExternalAtprotoBinding(binding)) {
      if (!this.externalWriteGateway || !auth.tokenId) {
        throw XrpcErrors.authRequired('External AT session is not available');
      }

      const result = await this.externalWriteGateway.deleteRecord(auth.tokenId, input);
      return {
        headers: { 'Content-Type': 'application/json' },
        body: result ?? {},
      };
    }

    const result = await this.writeGateway.deleteRecord(input, auth);

    return {
      headers: { 'Content-Type': 'application/json' },
      // deleteRecord returns empty body on success per Lexicon spec,
      // but we include the commit object when available
      body: result.commit ? result : {},
    };
  }

  private _parseInput(body: Record<string, unknown> | undefined): AtDeleteRecordInput {
    if (!body || typeof body !== 'object') {
      throw XrpcErrors.invalidRequest('Request body is required');
    }

    const { repo, collection, rkey, swapRecord, swapCommit } =
      body as Record<string, unknown>;

    if (!repo || typeof repo !== 'string') {
      throw XrpcErrors.invalidRequest('repo is required');
    }
    if (!collection || typeof collection !== 'string') {
      throw XrpcErrors.invalidRequest('collection is required');
    }
    if (!NSID_RE.test(collection)) {
      throw XrpcErrors.invalidCollection(collection);
    }
    if (!rkey || typeof rkey !== 'string') {
      throw XrpcErrors.invalidRequest('rkey is required');
    }
    if (!RKEY_RE.test(rkey)) {
      throw XrpcErrors.invalidRkey(rkey);
    }

    return {
      repo: repo.trim(),
      collection: collection.trim(),
      rkey: rkey.trim(),
      ...(swapRecord && typeof swapRecord === 'string' ? { swapRecord } : {}),
      ...(swapCommit && typeof swapCommit === 'string' ? { swapCommit } : {}),
    };
  }

  private _assertRepoOwnership(repo: string, auth: AtSessionContext): void {
    const normalizedRepo = repo.trim().toLowerCase();
    if (
      normalizedRepo !== auth.did.toLowerCase() &&
      normalizedRepo !== auth.handle.toLowerCase()
    ) {
      throw XrpcErrors.forbidden(`Cannot delete from repo ${repo}: not the authenticated account`);
    }
  }
}
