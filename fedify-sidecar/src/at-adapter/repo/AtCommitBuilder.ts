import type { AtRepoOpV1 } from '../events/AtRepoEvents.js';
import type { RepositoryState } from '../../atproto/repo/AtprotoRepoState.js';
import type { SigningService } from '../../core-domain/contracts/SigningContracts.js';

export interface BuildCommitResult {
  did: string;
  rev: string;
  commitCid: string;
  prevCommitCid: string | null;
  ops: AtRepoOpV1[];
  signature: string;
  unsignedCommitBytesBase64: string;
}

export interface AtCommitBuilder {
  buildCommit(
    state: RepositoryState,
    ops: AtRepoOpV1[]
  ): Promise<BuildCommitResult>;
}

export class DefaultAtCommitBuilder implements AtCommitBuilder {
  constructor(private readonly signingService: SigningService) {}

  async buildCommit(
    state: RepositoryState,
    ops: AtRepoOpV1[]
  ): Promise<BuildCommitResult> {
    // 1. Validate ops
    if (ops.length === 0) {
      throw new Error('Cannot build commit with no ops');
    }

    const did = state.did;
    if (!did) {
      throw new Error('Repository state missing DID');
    }

    // 2. Load current MST root (mocked for now)
    // 3. Apply ops to MST (mocked for now)
    // 4. Compute new root CID (mocked for now)
    const newRootCid = 'bafyreimockrootcid' + Date.now();
    
    // Calculate new rev
    const currentRev = parseInt(state.rev || '0', 10);
    const newRev = (currentRev + 1).toString();

    // 5. Serialize unsigned commit bytes (mocked for now)
    const unsignedCommitBytesBase64 = Buffer.from(JSON.stringify({
      did,
      version: 3,
      data: newRootCid,
      rev: newRev,
      prev: state.rootCid || null
    })).toString('base64');

    // 6. Call SigningService signCommit
    const canonicalAccountId = ops[0]?.canonicalAccountId;
    if (!canonicalAccountId) {
      throw new Error('Cannot sign commit without canonicalAccountId');
    }

    const signResponse = await this.signingService.signAtprotoCommit({
      canonicalAccountId,
      did,
      unsignedCommitBytesBase64,
      rev: newRev
    });

    // 7. Attach signature
    const signature = signResponse.signatureBase64Url;

    // 8. Compute signed commit CID (mocked for now)
    const commitCid = 'bafyreimockcommitcid' + Date.now();

    return {
      did,
      rev: newRev,
      commitCid,
      prevCommitCid: state.rootCid || null,
      ops,
      signature,
      unsignedCommitBytesBase64
    };
  }
}
