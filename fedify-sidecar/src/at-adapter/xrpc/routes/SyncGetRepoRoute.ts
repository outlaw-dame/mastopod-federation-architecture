/**
 * V6.5 Phase 4: com.atproto.sync.getRepo
 *
 * Returns the full CAR export of a hosted AT repository.
 *
 * Security:
 *   - DID is validated before any storage access.
 *   - Only active repos are served; deactivated/taken-down repos return 400.
 *   - The "since" parameter is explicitly rejected in Phase 4 with a
 *     documented error rather than silently ignored.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-sync#comatprotosyncgetrepo
 */

import { AtCarExporter } from '../../repo/AtCarExporter';
import { HandleResolutionReader, isValidDid } from '../../identity/HandleResolutionReader';
import { AtprotoRepoRegistry } from '../../../atproto/repo/AtprotoRepoRegistry';
import { XrpcErrors } from '../middleware/XrpcErrorMapper';

export interface SyncGetRepoRouteDeps {
  carExporter: AtCarExporter;
  handleResolutionReader: HandleResolutionReader;
  repoRegistry: AtprotoRepoRegistry;
}

export interface SyncGetRepoResult {
  headers: Record<string, string>;
  body: Uint8Array;
}

export class SyncGetRepoRoute {
  constructor(private readonly deps: SyncGetRepoRouteDeps) {}

  async handle(did: string | undefined, since?: string): Promise<SyncGetRepoResult> {
    // 1. Validate input.
    if (!did || !did.trim()) {
      throw XrpcErrors.invalidRequest('did parameter is required');
    }
    const trimmedDid = did.trim();
    if (!isValidDid(trimmedDid)) {
      throw XrpcErrors.invalidDid(trimmedDid);
    }

    // 2. "since" is not supported in Phase 4.
    if (since !== undefined && since !== '') {
      throw XrpcErrors.invalidRequest(
        'Partial CAR export via "since" is not supported in this version. ' +
        'Fetch the full repo and use getLatestCommit to detect staleness.'
      );
    }

    // 3. Resolve the DID.
    const resolved = await this.deps.handleResolutionReader.resolveRepoInput(trimmedDid);
    if (!resolved) {
      throw XrpcErrors.repoNotFound(trimmedDid);
    }

    // 4. Check repo status — only serve active repos.
    const repoState = await this.deps.repoRegistry.getByDid(resolved.did);
    if (!repoState) {
      throw XrpcErrors.repoNotFound(resolved.did);
    }

    // 5. Export CAR.
    const carBytes = await this.deps.carExporter.exportRepo(resolved.did);

    return {
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
      body: carBytes
    };
  }
}
