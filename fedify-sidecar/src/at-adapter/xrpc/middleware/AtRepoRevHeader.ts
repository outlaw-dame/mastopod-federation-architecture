/**
 * V6.5 Phase 4: Atproto-Repo-Rev Header Middleware
 *
 * The ATProto sync spec recommends that account-scoped responses include an
 * "Atproto-Repo-Rev" header containing the current repo revision.  This
 * allows downstream consumers to detect staleness without fetching the full
 * repo state.
 *
 * Ref: https://atproto.com/specs/repository#commit-objects
 */

import { AtprotoRepoRegistry } from '../../../atproto/repo/AtprotoRepoRegistry.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface RepoRevLookup {
  getCurrentRev(did: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultRepoRevLookup implements RepoRevLookup {
  constructor(private readonly repoRegistry: AtprotoRepoRegistry) {}

  async getCurrentRev(did: string): Promise<string | null> {
    try {
      const state = await this.repoRegistry.getByDid(did);
      return state?.rev ?? null;
    } catch {
      // Rev header is advisory; never fail a request because of it.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Merge the Atproto-Repo-Rev header into an existing headers map.
 * If the rev cannot be determined, the headers map is returned unchanged.
 */
export async function withRepoRevHeader(
  did: string,
  lookup: RepoRevLookup,
  headers: Record<string, string> = {}
): Promise<Record<string, string>> {
  const rev = await lookup.getCurrentRev(did);
  if (rev) {
    return { ...headers, 'Atproto-Repo-Rev': rev };
  }
  return headers;
}
