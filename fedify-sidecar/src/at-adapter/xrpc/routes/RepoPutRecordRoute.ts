/**
 * V6.5 Phase 7: com.atproto.repo.putRecord
 *
 * Create or replace a record at a specific rkey (upsert semantics).
 * Required for profile records (singleton per DID) and any collection
 * where update-by-rkey semantics are needed.
 *
 * Design rule: same canonical-first discipline as createRecord.
 * The record is NOT written directly to the AT repo — it is normalized
 * into a CanonicalMutationEnvelope, submitted to Tier 1, and the
 * projection result is awaited for the response URI + CID.
 *
 * Supported collections (Phase 7):
 *   app.bsky.actor.profile  (primary use case — singleton upsert)
 *   app.bsky.feed.post      (only if canonical post editing is supported)
 *
 * Ref: https://atproto.com/lexicon/com-atproto-repo#comatprotorepoPutRecord
 */

import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';
import { SUPPORTED_COLLECTIONS } from '../../writes/AtWriteTypes.js';
import type { IdentityBindingRepository } from '../../../core-domain/identity/IdentityBindingRepository.js';
import type {
  AtPutRecordInput,
  AtWriteGateway,
} from '../../writes/AtWriteTypes.js';
import type { AtSessionContext } from '../../auth/AtSessionTypes.js';
import type { ExternalWriteGateway } from '../../external/ExternalWriteGateway.js';
import { isExternalAtprotoBinding } from '../../external/ExternalAccountMode.js';

export class RepoPutRecordRoute {
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

      const result = await this.externalWriteGateway.putRecord(auth.tokenId, input);
      return {
        headers: { 'Content-Type': 'application/json' },
        body: result,
      };
    }

    const result = await this.writeGateway.putRecord(input, auth);

    return {
      headers: { 'Content-Type': 'application/json' },
      body: result,
    };
  }

  private _parseInput(body: Record<string, unknown> | undefined): AtPutRecordInput {
    if (!body || typeof body !== 'object') {
      throw XrpcErrors.invalidRequest('Request body is required');
    }

    const { repo, collection, rkey, validate, record, swapRecord, swapCommit } =
      body as Record<string, unknown>;

    if (!repo || typeof repo !== 'string') {
      throw XrpcErrors.invalidRequest('repo is required');
    }
    if (!collection || typeof collection !== 'string') {
      throw XrpcErrors.invalidRequest('collection is required');
    }
    if (!SUPPORTED_COLLECTIONS.has(collection)) {
      throw XrpcErrors.unsupportedCollection(collection);
    }
    if (!rkey || typeof rkey !== 'string') {
      throw XrpcErrors.invalidRequest('rkey is required for putRecord');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw XrpcErrors.invalidRequest('record must be an object');
    }

    return {
      repo: repo.trim(),
      collection: collection as AtPutRecordInput['collection'],
      rkey: rkey.trim(),
      ...(validate !== undefined ? { validate: Boolean(validate) } : {}),
      record: record as Record<string, unknown>,
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
      throw XrpcErrors.forbidden(`Cannot write to repo ${repo}: not the authenticated account`);
    }
  }
}
