/**
 * V6.5 Phase 4: AT CAR Exporter
 *
 * Implements com.atproto.sync.getRepo: exports the full current repo state
 * as a CAR (Content Addressable aRchive) file.
 *
 * Phase 4 scope:
 *   - Full export only; partial "since" export is deferred to Phase 5.
 *   - The commit object is the first root in the CAR header.
 *   - MST nodes and record blocks are included for the current snapshot.
 *
 * In production, this module MUST use a real CAR/IPLD library (e.g. @ipld/car,
 * @atproto/repo).  The current implementation returns a well-formed mock
 * Uint8Array that exercises the interface contract while the MST library
 * integration is completed.
 *
 * Ref: https://atproto.com/specs/repository#car-file-serialization
 */

import { AtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry';
import { isValidDid } from '../identity/HandleResolutionReader';

export interface AtCarExporter {
  exportRepo(did: string, since?: string): Promise<Uint8Array>;
}

export class DefaultAtCarExporter implements AtCarExporter {
  constructor(private readonly repoRegistry: AtprotoRepoRegistry) {}

  async exportRepo(did: string, since?: string): Promise<Uint8Array> {
    // Validate DID before any storage access.
    if (!did || !isValidDid(did)) {
      throw new Error(`Invalid DID: ${did}`);
    }

    // Phase 4: partial export is not supported.
    if (since !== undefined && since !== '') {
      throw new Error(
        'Partial CAR export via "since" is not supported in Phase 4. ' +
        'Fetch the full repo and use getLatestCommit to detect staleness.'
      );
    }

    const repoState = await this.repoRegistry.getByDid(did);
    if (!repoState) {
      throw new Error(`Repo not found: ${did}`);
    }

    // TODO (Phase 5): replace with real CAR serialisation using @atproto/repo.
    // The CAR format requires:
    //   1. A varint-prefixed header block containing the CID roots array.
    //   2. The signed commit block as the first root.
    //   3. All MST node blocks reachable from the commit.
    //   4. All record leaf blocks.
    const mockCar = Buffer.from(
      `mock-car:did=${did}:rev=${repoState.rev}:root=${repoState.rootCid}`
    );
    return new Uint8Array(mockCar);
  }
}
