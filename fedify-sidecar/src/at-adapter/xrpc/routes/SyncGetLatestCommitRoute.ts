/**
 * V6.5 Phase 4: com.atproto.sync.getLatestCommit
 *
 * Returns the current commit CID and revision for a hosted repo.
 * Includes the Atproto-Repo-Rev header as a synchronisation hint.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-sync#comatprotosyncgetlatestcommit
 */

import { AtprotoRepoRegistry } from '../../../atproto/repo/AtprotoRepoRegistry';
import { HandleResolutionReader, isValidDid } from '../../identity/HandleResolutionReader';
import { XrpcErrors } from '../middleware/XrpcErrorMapper';
import { RepoRevLookup, withRepoRevHeader } from '../middleware/AtRepoRevHeader';

export interface GetLatestCommitResponse {
  cid: string;
  rev: string;
}

export interface SyncGetLatestCommitResult {
  headers: Record<string, string>;
  body: GetLatestCommitResponse;
}

export class SyncGetLatestCommitRoute {
  constructor(
    private readonly repoRegistry: AtprotoRepoRegistry,
    private readonly handleResolver: HandleResolutionReader,
    private readonly revLookup: RepoRevLookup
  ) {}

  async handle(did: string | undefined): Promise<SyncGetLatestCommitResult> {
    // 1. Validate.
    if (!did || !did.trim()) {
      throw XrpcErrors.invalidRequest('did parameter is required');
    }
    const trimmedDid = did.trim();
    if (!isValidDid(trimmedDid)) {
      throw XrpcErrors.invalidDid(trimmedDid);
    }

    // 2. Resolve.
    const resolved = await this.handleResolver.resolveRepoInput(trimmedDid);
    if (!resolved) {
      throw XrpcErrors.repoNotFound(trimmedDid);
    }

    // 3. Load state.
    const state = await this.repoRegistry.getByDid(resolved.did);
    if (!state || !state.rootCid || !state.rev) {
      throw XrpcErrors.repoNotFound(resolved.did);
    }

    // 4. Build response with rev header.
    const headers = await withRepoRevHeader(resolved.did, this.revLookup);

    return {
      headers,
      body: { cid: state.rootCid, rev: state.rev }
    };
  }
}
