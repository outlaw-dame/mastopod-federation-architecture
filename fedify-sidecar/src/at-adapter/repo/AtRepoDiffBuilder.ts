/**
 * V6.5 Phase 4: AT Repo Diff Builder
 *
 * Builds a CAR slice from a locally generated AtCommitV1 event for use in
 * the subscribeRepos firehose #commit message.
 *
 * The ATProto sync spec requires that #commit messages include a "blocks"
 * field containing a CAR slice with the commit block and all changed data
 * blocks, with the commit CID as the first root.
 *
 * Phase 4 scope:
 *   - Supports only diffs generated from locally created commits.
 *   - Does not reconstruct arbitrary historical diffs.
 *   - CAR slice is a mock Uint8Array pending real IPLD/CAR library integration.
 *
 * Ref: https://atproto.com/specs/event-stream#commit
 */

import { AtCommitV1 } from '../events/AtRepoEvents';

export interface RepoDiffOp {
  action: 'create' | 'update' | 'delete';
  path: string; // collection/rkey
  cid: string | null;
  prev?: string;
}

export interface RepoDiffBuildResult {
  commitCid: string;
  prevData?: string | null;
  ops: RepoDiffOp[];
  carSlice: Uint8Array;
}

export interface AtRepoDiffBuilder {
  buildFromCommit(commit: AtCommitV1): Promise<RepoDiffBuildResult>;
}

export class DefaultAtRepoDiffBuilder implements AtRepoDiffBuilder {
  async buildFromCommit(commit: AtCommitV1): Promise<RepoDiffBuildResult> {
    const ops: RepoDiffOp[] = commit.ops.map(op => ({
      action: op.action,
      path: `${op.collection}/${op.rkey}`,
      cid: op.cid ?? null
    }));

    // TODO (Phase 5): replace with real CAR slice using @atproto/repo.
    // The slice must contain:
    //   1. The signed commit block (first root).
    //   2. All MST node blocks changed by this commit.
    //   3. All record leaf blocks that were created or updated.
    const mockSlice = Buffer.from(
      `mock-car-slice:commit=${commit.commitCid}:ops=${ops.length}`
    );

    return {
      commitCid: commit.commitCid,
      prevData: commit.prevCommitCid,
      ops,
      carSlice: new Uint8Array(mockSlice)
    };
  }
}
