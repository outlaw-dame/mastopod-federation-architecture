/**
 * V6.5 Phase 4: com.atproto.repo.listRecords
 *
 * Returns a paginated list of records in a collection.
 *
 * Security:
 *   - Collection NSID and cursor are validated before any storage access.
 *   - limit is clamped to [1, 100] to prevent resource exhaustion.
 *   - Cursor is validated to prevent injection.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-repo#comatprotolistrecords
 */

import { AtRecordReader } from '../../repo/AtRecordReader';
import { HandleResolutionReader } from '../../identity/HandleResolutionReader';
import { XrpcErrors } from '../middleware/XrpcErrorMapper';
import { RepoRevLookup, withRepoRevHeader } from '../middleware/AtRepoRevHeader';

const NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){1,}$/;
const CURSOR_RE = /^[a-zA-Z0-9_-]{1,512}$/;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export class RepoListRecordsRoute {
  constructor(
    private readonly recordReader: AtRecordReader,
    private readonly handleResolver: HandleResolutionReader,
    private readonly revLookup: RepoRevLookup
  ) {}

  async handle(
    repo: string | undefined,
    collection: string | undefined,
    limit?: number,
    cursor?: string,
    reverse?: boolean
  ): Promise<{ headers: Record<string, string>; body: any }> {
    // 1. Validate required parameters.
    if (!repo?.trim()) throw XrpcErrors.invalidRequest('repo parameter is required');
    if (!collection?.trim()) throw XrpcErrors.invalidRequest('collection parameter is required');

    const trimmedCollection = collection.trim();
    if (!NSID_RE.test(trimmedCollection)) {
      throw XrpcErrors.invalidCollection(trimmedCollection);
    }

    // 2. Validate and clamp limit.
    let safeLimit = DEFAULT_LIMIT;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw XrpcErrors.invalidRequest('limit must be a positive integer');
      }
      safeLimit = Math.min(limit, MAX_LIMIT);
    }

    // 3. Validate cursor.
    if (cursor !== undefined && cursor !== '' && !CURSOR_RE.test(cursor)) {
      throw XrpcErrors.invalidCursor(cursor);
    }

    // 4. Resolve repo.
    const resolved = await this.handleResolver.resolveRepoInput(repo.trim());
    if (!resolved) throw XrpcErrors.repoNotFound(repo.trim());

    // 5. Fetch records.
    const result = await this.recordReader.listRecords({
      repo: resolved.did,
      collection: trimmedCollection,
      limit: safeLimit,
      cursor: cursor || undefined,
      reverse: reverse === true
    });

    // 6. Build response.
    const headers = await withRepoRevHeader(resolved.did, this.revLookup);

    return {
      headers,
      body: {
        records: result.records.map(r => ({
          uri: r.uri,
          cid: r.cid,
          value: r.value
        })),
        cursor: result.cursor
      }
    };
  }
}
