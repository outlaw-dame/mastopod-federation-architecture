/**
 * V6.5 Phase 7: com.atproto.repo.createRecord
 *
 * Creates a new record in a repository.  Accepts standard AT client writes
 * and routes them through the canonical Tier 1 write path.
 *
 * Design rule: this route does NOT write to the AT repo directly.
 * Flow: validate → authenticate → normalize to CanonicalMutationEnvelope
 *       → CanonicalClientWriteService (Tier 1) → await AT projection result
 *       → return URI + CID.
 *
 * Supported collections (Phase 7 allowlist):
 *   app.bsky.feed.post
 *   app.bsky.actor.profile
 *   app.bsky.graph.follow
 *   app.bsky.feed.like
 *   app.bsky.feed.repost
 *
 * Ref: https://atproto.com/lexicon/com-atproto-repo#comatprotorepocreaterecord
 */

import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';
import { SUPPORTED_COLLECTIONS } from '../../writes/AtWriteTypes.js';
import type { IdentityBindingRepository } from '../../../core-domain/identity/IdentityBindingRepository.js';
import type {
  AtCreateRecordInput,
  AtWriteGateway,
} from '../../writes/AtWriteTypes.js';
import type { AtSessionContext } from '../../auth/AtSessionTypes.js';
import type { ExternalWriteGateway } from '../../external/ExternalWriteGateway.js';
import { isExternalAtprotoBinding } from '../../external/ExternalAccountMode.js';

/** Projection result timeout: 5 s is aggressive but safe for most setups. */
const WRITE_RESULT_TIMEOUT_MS = 5_000;

export class RepoCreateRecordRoute {
  constructor(
    private readonly writeGateway: AtWriteGateway,
    private readonly identityRepo?: IdentityBindingRepository,
    private readonly externalWriteGateway?: ExternalWriteGateway
  ) {}

  async handle(
    body: Record<string, unknown> | undefined,
    auth: AtSessionContext
  ): Promise<{ headers: Record<string, string>; body: unknown }> {
    // 1. Parse and validate the request body
    const input = this._parseInput(body);

    // 2. Enforce repo ownership: caller may only write to their own repo
    this._assertRepoOwnership(input.repo, auth);

    const binding = this.identityRepo
      ? await this.identityRepo.getByCanonicalAccountId(auth.canonicalAccountId)
      : null;

    if (isExternalAtprotoBinding(binding)) {
      if (!this.externalWriteGateway || !auth.tokenId) {
        throw XrpcErrors.authRequired('External AT session is not available');
      }

      const result = await this.externalWriteGateway.createRecord(auth.tokenId, input);
      return {
        headers: { 'Content-Type': 'application/json' },
        body: result,
      };
    }

    // 3. Delegate to write gateway (normalize → Tier 1 → await projection)
    const result = await this.writeGateway.createRecord(input, auth);

    return {
      headers: { 'Content-Type': 'application/json' },
      body: result,
    };
  }

  private _parseInput(body: Record<string, unknown> | undefined): AtCreateRecordInput {
    if (!body || typeof body !== 'object') {
      throw XrpcErrors.invalidRequest('Request body is required');
    }

    const { repo, collection, rkey, validate, record, swapCommit } = body as Record<string, unknown>;

    if (!repo || typeof repo !== 'string') {
      throw XrpcErrors.invalidRequest('repo is required');
    }
    if (!collection || typeof collection !== 'string') {
      throw XrpcErrors.invalidRequest('collection is required');
    }
    if (!SUPPORTED_COLLECTIONS.has(collection)) {
      throw XrpcErrors.unsupportedCollection(collection);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw XrpcErrors.invalidRequest('record must be an object');
    }
    if (rkey !== undefined && typeof rkey !== 'string') {
      throw XrpcErrors.invalidRequest('rkey must be a string');
    }

    return {
      repo: repo.trim(),
      collection: collection as AtCreateRecordInput['collection'],
      ...(rkey ? { rkey: rkey.trim() } : {}),
      ...(validate !== undefined ? { validate: Boolean(validate) } : {}),
      record: record as Record<string, unknown>,
      ...(swapCommit && typeof swapCommit === 'string' ? { swapCommit } : {}),
    };
  }

  private _assertRepoOwnership(repo: string, auth: AtSessionContext): void {
    // repo may be a DID or a handle — check against the session's DID and handle
    const normalizedRepo = repo.trim().toLowerCase();
    const sessionDid = auth.did.toLowerCase();
    const sessionHandle = auth.handle.toLowerCase();

    if (normalizedRepo !== sessionDid && normalizedRepo !== sessionHandle) {
      throw XrpcErrors.forbidden(`Cannot write to repo ${repo}: not the authenticated account`);
    }
  }
}
