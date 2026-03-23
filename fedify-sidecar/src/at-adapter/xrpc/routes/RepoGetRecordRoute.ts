/**
 * V6.5 Phase 4: com.atproto.repo.getRecord
 *
 * Returns a single record by repo (DID or handle), collection NSID, and rkey.
 *
 * Security:
 *   - All three required parameters are validated before any storage access.
 *   - Collection NSID is checked against a strict regex to prevent injection.
 *   - rkey is validated against the ATProto rkey grammar.
 *   - CID, if supplied, is validated before use.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-repo#comatprotorepogettrecord
 */

import { AtRecordReader } from '../../repo/AtRecordReader';
import { HandleResolutionReader } from '../../identity/HandleResolutionReader';
import { XrpcErrors } from '../middleware/XrpcErrorMapper';
import { RepoRevLookup, withRepoRevHeader } from '../middleware/AtRepoRevHeader';

/** Lexicon NSID: segments of [a-zA-Z0-9-], joined by dots, 2+ segments. */
const NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){1,}$/;

/** rkey: 1-512 chars, alphanumeric + hyphen + underscore. */
const RKEY_RE = /^[a-zA-Z0-9_-]{1,512}$/;

/** CID: base32 or base58 encoded multihash, 8-200 chars. */
const CID_RE = /^[a-zA-Z0-9+/=]{8,200}$/;

export class RepoGetRecordRoute {
  constructor(
    private readonly recordReader: AtRecordReader,
    private readonly handleResolver: HandleResolutionReader,
    private readonly revLookup: RepoRevLookup
  ) {}

  async handle(
    repo: string | undefined,
    collection: string | undefined,
    rkey: string | undefined,
    cid?: string
  ): Promise<{ headers: Record<string, string>; body: any }> {
    // 1. Validate required parameters.
    if (!repo?.trim()) throw XrpcErrors.invalidRequest('repo parameter is required');
    if (!collection?.trim()) throw XrpcErrors.invalidRequest('collection parameter is required');
    if (!rkey?.trim()) throw XrpcErrors.invalidRequest('rkey parameter is required');

    const trimmedCollection = collection.trim();
    const trimmedRkey = rkey.trim();

    if (!NSID_RE.test(trimmedCollection)) {
      throw XrpcErrors.invalidCollection(trimmedCollection);
    }
    if (!RKEY_RE.test(trimmedRkey)) {
      throw XrpcErrors.invalidRkey(trimmedRkey);
    }
    if (cid !== undefined && cid !== '' && !CID_RE.test(cid)) {
      throw XrpcErrors.invalidRequest(`Invalid CID format: ${cid}`);
    }

    // 2. Resolve repo.
    const resolved = await this.handleResolver.resolveRepoInput(repo.trim());
    if (!resolved) throw XrpcErrors.repoNotFound(repo.trim());

    // 3. Fetch record.
    const record = await this.recordReader.getRecord(
      resolved.did,
      trimmedCollection,
      trimmedRkey,
      cid || undefined
    );
    if (!record) {
      throw XrpcErrors.recordNotFound(`${resolved.did}/${trimmedCollection}/${trimmedRkey}`);
    }

    // 4. Build response.
    const headers = await withRepoRevHeader(resolved.did, this.revLookup);

    return {
      headers,
      body: { uri: record.uri, cid: record.cid, value: record.value }
    };
  }
}
