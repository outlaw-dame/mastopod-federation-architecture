/**
 * V6.5 ATProto Repository State - Repository Metadata Management
 *
 * Manages the state of ATProto repositories including:
 * - Repository root CID (Merkle Search Tree root)
 * - Commit history
 * - Record collections
 * - Repository metadata
 *
 * This is the in-memory/cached representation of repository state.
 * Authoritative state is stored in Redis.
 */

/**
 * Repository commit
 */
export interface RepositoryCommit {
  /**
   * Commit CID
   */
  cid: string;

  /**
   * Root node CID
   */
  rootCid: string;

  /**
   * Revision number
   */
  rev: string;

  /**
   * Timestamp of commit
   */
  timestamp: string;

  /**
   * Signature (base64url)
   */
  signature: string;

  /**
   * Previous commit CID
   */
  prevCid?: string;
}

/**
 * Record collection metadata
 */
export interface RecordCollection {
  /**
   * Collection NSID (e.g., app.bsky.feed.post)
   */
  nsid: string;

  /**
   * Number of records in collection
   */
  recordCount: number;

  /**
   * Collection root CID in MST
   */
  rootCid?: string;

  /**
   * Timestamp of last update
   */
  lastUpdated: string;
}

/**
 * Repository state
 */
export interface RepositoryState {
  /**
   * DID of repository owner
   */
  did: string;

  /**
   * Current root CID (Merkle Search Tree root)
   */
  rootCid: string | null;

  /**
   * Current revision number
   */
  rev: string;

  /**
   * Commit history (most recent first)
   */
  commits: RepositoryCommit[];

  /**
   * Record collections
   */
  collections: RecordCollection[];

  /**
   * Total record count
   */
  totalRecords: number;

  /**
   * Repository size in bytes
   */
  sizeBytes: number;

  /**
   * Repository status
   */
  status: "active" | "suspended" | "deactivated";

  /**
   * Timestamp of last commit
   */
  lastCommitAt: string;

  /**
   * Timestamp of state snapshot
   */
  snapshotAt: string;

  /**
   * Repository creation time
   */
  createdAt: string;

  /**
   * Last update time
   */
  updatedAt: string;
}

/**
 * ATProto Repository State Manager
 *
 * Manages repository state and commit history.
 */
export class AtprotoRepoStateManager {
  /**
   * Maximum commits to keep in memory
   */
  private readonly MAX_COMMITS = 100;

  /**
   * Create new repository state
   *
   * @param did - Repository DID
   * @param initialRootCid - Initial root CID
   * @returns Repository state
   */
  createRepositoryState(did: string, initialRootCid: string): RepositoryState {
    const now = new Date().toISOString();

    return {
      did,
      rootCid: initialRootCid,
      rev: "0",
      commits: [
        {
          cid: initialRootCid,
          rootCid: initialRootCid,
          rev: "0",
          timestamp: now,
          signature: "",
        },
      ],
      collections: [],
      totalRecords: 0,
      sizeBytes: 0,
      status: "active",
      lastCommitAt: now,
      snapshotAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Record a new commit
   *
   * @param state - Current repository state
   * @param commit - New commit
   * @returns Updated state
   */
  recordCommit(state: RepositoryState, commit: RepositoryCommit): RepositoryState {
    const updated = { ...state };

    updated.commits = [commit, ...state.commits].slice(0, this.MAX_COMMITS);
    updated.rootCid = commit.rootCid;
    updated.rev = commit.rev;
    updated.lastCommitAt = commit.timestamp;
    updated.snapshotAt = new Date().toISOString();
    updated.updatedAt = updated.snapshotAt;

    return updated;
  }

  /**
   * Update collection metadata
   *
   * @param state - Current repository state
   * @param nsid - Collection NSID
   * @param recordCount - Number of records
   * @returns Updated state
   */
  updateCollection(
    state: RepositoryState,
    nsid: string,
    recordCount: number,
  ): RepositoryState {
    const updated = { ...state };
    updated.collections = [...state.collections];

    const existing = updated.collections.findIndex((collection) => collection.nsid === nsid);
    const now = new Date().toISOString();

    if (existing >= 0) {
      const current = updated.collections[existing]!;
      updated.collections[existing] = {
        ...current,
        recordCount,
        lastUpdated: now,
      };
    } else {
      updated.collections.push({
        nsid,
        recordCount,
        lastUpdated: now,
      });
    }

    updated.totalRecords = updated.collections.reduce((sum, collection) => sum + collection.recordCount, 0);
    updated.updatedAt = now;
    updated.snapshotAt = now;
    return updated;
  }

  /**
   * Get collection by NSID
   *
   * @param state - Repository state
   * @param nsid - Collection NSID
   * @returns Collection or undefined
   */
  getCollection(state: RepositoryState, nsid: string): RecordCollection | undefined {
    return state.collections.find((collection) => collection.nsid === nsid);
  }

  /**
   * Get commit history
   *
   * @param state - Repository state
   * @param limit - Maximum commits to return
   * @returns Commit history
   */
  getCommitHistory(state: RepositoryState, limit = 10): RepositoryCommit[] {
    return state.commits.slice(0, limit);
  }

  /**
   * Get commit by CID
   *
   * @param state - Repository state
   * @param cid - Commit CID
   * @returns Commit or undefined
   */
  getCommitByCid(state: RepositoryState, cid: string): RepositoryCommit | undefined {
    return state.commits.find((commit) => commit.cid === cid);
  }

  /**
   * Get commit by revision
   *
   * @param state - Repository state
   * @param rev - Revision number
   * @returns Commit or undefined
   */
  getCommitByRev(state: RepositoryState, rev: string): RepositoryCommit | undefined {
    return state.commits.find((commit) => commit.rev === rev);
  }

  /**
   * Calculate next revision number
   *
   * @param state - Repository state
   * @returns Next revision
   */
  getNextRevision(state: RepositoryState): string {
    const current = parseInt(state.rev, 10);
    return (current + 1).toString();
  }

  /**
   * Validate repository state
   *
   * @param state - Repository state
   * @returns Validation result
   */
  validate(state: RepositoryState): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!state.did) {
      errors.push("Missing DID");
    }

    if (!state.rootCid) {
      errors.push("Missing root CID");
    }

    if (!state.rev) {
      errors.push("Missing revision");
    }

    if (state.commits.length === 0) {
      errors.push("No commits in history");
    }

    for (let index = 0; index < state.commits.length - 1; index += 1) {
      const current = state.commits[index];
      const next = state.commits[index + 1];

      if (current && next && current.prevCid !== next.cid) {
        errors.push(`Commit chain broken at index ${index}`);
      }
    }

    const collectionTotal = state.collections.reduce((sum, collection) => sum + collection.recordCount, 0);
    if (state.totalRecords !== collectionTotal) {
      errors.push("Total records mismatch");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Format state for logging
   *
   * @param state - Repository state
   * @returns Human-readable state description
   */
  formatState(state: RepositoryState): string {
    const lines = [
      `DID: ${state.did}`,
      `Root CID: ${(state.rootCid ?? "").substring(0, 12)}...`,
      `Revision: ${state.rev}`,
      `Total Records: ${state.totalRecords}`,
      `Collections: ${state.collections.length}`,
      `Commits: ${state.commits.length}`,
      `Last Commit: ${new Date(state.lastCommitAt).toISOString()}`,
    ];

    return lines.join(" | ");
  }
}
