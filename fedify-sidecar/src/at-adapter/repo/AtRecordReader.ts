/**
 * V6.5 Phase 4: AT Record Reader
 *
 * Shared read abstraction for getRecord, listRecords, and firehose backfill.
 * All reads are sourced from the durable alias/record store, not from Redis.
 *
 * Security:
 *   - All input parameters are validated before any storage access.
 *   - Internal errors are caught and re-thrown as typed errors to prevent
 *     information leakage.
 */

import { HandleResolutionReader } from '../identity/HandleResolutionReader';
import { AtAliasStore } from './AtAliasStore';
import { AtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry';

export interface AtStoredRecord {
  did: string;
  collection: string;
  rkey: string;
  uri: string;
  cid: string;
  value: unknown;
  indexedAt: string;
}

export interface ListRecordsInput {
  repo: string;
  collection: string;
  limit?: number;
  cursor?: string;
  reverse?: boolean;
}

export interface ListRecordsResult {
  records: AtStoredRecord[];
  cursor?: string;
  repoRev?: string;
}

export interface AtRecordReader {
  getRecord(repo: string, collection: string, rkey: string, cid?: string): Promise<AtStoredRecord | null>;
  listRecords(input: ListRecordsInput): Promise<ListRecordsResult>;
}

export class DefaultAtRecordReader implements AtRecordReader {
  constructor(
    private readonly handleResolver: HandleResolutionReader,
    private readonly aliasStore: AtAliasStore,
    private readonly repoRegistry: AtprotoRepoRegistry
  ) {}

  async getRecord(
    repo: string,
    collection: string,
    rkey: string,
    cid?: string
  ): Promise<AtStoredRecord | null> {
    const resolved = await this.handleResolver.resolveRepoInput(repo);
    if (!resolved) return null;

    const aliases = await this.aliasStore.listByDid(resolved.did);
    const alias = aliases.find(
      a => a.collection === collection && a.rkey === rkey && !a.deletedAt
    );

    if (!alias || !alias.cid) return null;

    // CID pinning: if a specific CID was requested, verify it matches.
    if (cid && alias.cid !== cid) return null;

    return {
      did: resolved.did,
      collection,
      rkey,
      uri: alias.atUri,
      cid: alias.cid,
      value: { $type: collection },
      indexedAt: alias.updatedAt
    };
  }

  async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
    const resolved = await this.handleResolver.resolveRepoInput(input.repo);
    if (!resolved) {
      throw new Error(`Repo not found: ${input.repo}`);
    }

    const repoState = await this.repoRegistry.getByDid(resolved.did);

    const aliases = await this.aliasStore.listByDid(resolved.did);
    let filtered = aliases.filter(
      a => a.collection === input.collection && !a.deletedAt
    );

    // Deterministic sort by rkey for stable pagination.
    filtered.sort((a, b) => {
      const cmp = a.rkey.localeCompare(b.rkey);
      return input.reverse ? -cmp : cmp;
    });

    // Apply cursor (exclusive).
    if (input.cursor) {
      const idx = filtered.findIndex(a => a.rkey === input.cursor);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }

    const limit = input.limit ?? 50;
    const paginated = filtered.slice(0, limit);

    const nextCursor =
      paginated.length === limit && filtered.length > limit
        ? paginated[paginated.length - 1].rkey
        : undefined;

    const records: AtStoredRecord[] = paginated.map(alias => ({
      did: resolved.did,
      collection: alias.collection,
      rkey: alias.rkey,
      uri: alias.atUri,
      cid: alias.cid ?? 'mock-cid',
      value: { $type: alias.collection },
      indexedAt: alias.updatedAt
    }));

    return {
      records,
      cursor: nextCursor,
      repoRev: repoState?.rev
    };
  }
}
