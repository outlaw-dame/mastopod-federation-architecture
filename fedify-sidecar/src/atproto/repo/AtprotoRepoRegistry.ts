/**
 * V6.5 ATProto Repository Registry - Multi-Repository Management
 *
 * Manages multiple ATProto repositories (one per DID).
 * Provides efficient lookup and state management.
 *
 * Uses Redis for persistence and in-memory cache for performance.
 */

import { randomUUID } from 'node:crypto';
import { RepositoryState } from './AtprotoRepoState.js';

const REPO_SCAN_COUNT = 128;
const REPO_MGET_BATCH = 128;
const REPO_SCAN_SESSION_TTL_MS = 5 * 60_000;
const REPO_SCAN_SESSION_PREFIX = 'atproto:repos:list:seen:';
const COLLECTION_INDEX_PREFIX = 'atproto:repos:collection:';
const COLLECTION_INDEX_COMPLETE_PREFIX = 'atproto:repos:collection-complete:';

const OPEN_REPO_SCAN_SESSION_LUA = `
local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return redis.error_reply('ATPROTO_REPO_SCAN_SESSION_INVALID_TTL')
end
redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('PEXPIRE', KEYS[1], ttl) ~= 1 then
  return redis.error_reply('ATPROTO_REPO_SCAN_SESSION_TTL_FAILED')
end
return 1
`;

const DEDUPE_REPO_SCAN_IDS_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) ~= 1 then
  return redis.error_reply('ATPROTO_REPO_SCAN_SESSION_EXPIRED')
end
local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return redis.error_reply('ATPROTO_REPO_SCAN_SESSION_INVALID_TTL')
end
local fresh = {}
for i = 3, #ARGV do
  if redis.call('SADD', KEYS[1], ARGV[i]) == 1 then
    table.insert(fresh, ARGV[i])
  end
end
redis.call('PEXPIRE', KEYS[1], ttl)
return fresh
`;

export enum RegistryErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  PERSISTENCE_ERROR = 'PERSISTENCE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

export class RegistryError extends Error {
  constructor(
    public code: RegistryErrorCode,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface AtprotoRepoRegistry {
  register(state: RepositoryState): Promise<void>;
  getByDid(did: string): Promise<RepositoryState | null>;
  update(state: RepositoryState): Promise<void>;
  delete(did: string): Promise<boolean>;
  list(limit?: number, offset?: number): Promise<RepositoryState[]>;
  count(): Promise<number>;
  exists(did: string): Promise<boolean>;
  getByCollection(nsid: string): Promise<RepositoryState[]>;
  getWithPendingCommits(): Promise<RepositoryState[]>;
  transaction<T>(callback: (registry: AtprotoRepoRegistry) => Promise<T>): Promise<T>;
  health(): Promise<boolean>;
  getRepoState(did: string): Promise<RepositoryState | null>;
}

export class InMemoryAtprotoRepoRegistry implements AtprotoRepoRegistry {
  private repositories = new Map<string, RepositoryState>();

  async register(state: RepositoryState): Promise<void> {
    if (this.repositories.has(state.did)) {
      throw new RegistryError(
        RegistryErrorCode.ALREADY_EXISTS,
        `Repository already exists: ${state.did}`
      );
    }
    this.repositories.set(state.did, state);
  }

  async getByDid(did: string): Promise<RepositoryState | null> {
    return this.repositories.get(did) || null;
  }

  async getRepoState(did: string): Promise<RepositoryState | null> {
    return this.getByDid(did);
  }

  async update(state: RepositoryState): Promise<void> {
    if (!this.repositories.has(state.did)) {
      throw new RegistryError(
        RegistryErrorCode.NOT_FOUND,
        `Repository not found: ${state.did}`
      );
    }
    this.repositories.set(state.did, state);
  }

  async delete(did: string): Promise<boolean> {
    return this.repositories.delete(did);
  }

  async list(limit: number = 100, offset: number = 0): Promise<RepositoryState[]> {
    return Array.from(this.repositories.values()).slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.repositories.size;
  }

  async exists(did: string): Promise<boolean> {
    return this.repositories.has(did);
  }

  async getByCollection(nsid: string): Promise<RepositoryState[]> {
    return Array.from(this.repositories.values()).filter((repo) =>
      repo.collections.some((c) => c.nsid === nsid)
    );
  }

  async getWithPendingCommits(): Promise<RepositoryState[]> {
    return [];
  }

  async transaction<T>(callback: (registry: AtprotoRepoRegistry) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async health(): Promise<boolean> {
    return true;
  }
}

export class RedisAtprotoRepoRegistry implements AtprotoRepoRegistry {
  private readonly keyPrefix = 'atproto:repo:';
  private readonly indexKey = 'atproto:repos';

  constructor(private redis: any) {}

  async register(state: RepositoryState): Promise<void> {
    const key = `${this.keyPrefix}${state.did}`;
    const exists = await this.redis.exists(key);
    if (exists) {
      throw new RegistryError(
        RegistryErrorCode.ALREADY_EXISTS,
        `Repository already exists: ${state.did}`
      );
    }

    const tx = this.redis
      .multi()
      .set(key, JSON.stringify(state), 'EX', 86400 * 30)
      .sadd(this.indexKey, state.did);
    for (const nsid of collectionNsids(state)) {
      tx.sadd(this.collectionIndexKey(nsid), state.did);
    }
    await tx.exec();
  }

  async getByDid(did: string): Promise<RepositoryState | null> {
    const key = `${this.keyPrefix}${did}`;
    const data = await this.redis.get(key);
    if (!data) return null;
    return JSON.parse(data);
  }

  async getRepoState(did: string): Promise<RepositoryState | null> {
    return this.getByDid(did);
  }

  async update(state: RepositoryState): Promise<void> {
    const key = `${this.keyPrefix}${state.did}`;
    const rawPrevious = await this.redis.get(key);
    if (!rawPrevious) {
      throw new RegistryError(
        RegistryErrorCode.NOT_FOUND,
        `Repository not found: ${state.did}`
      );
    }

    const previous = parseRepositoryStateBestEffort(rawPrevious);
    const previousCollections = new Set(previous ? collectionNsids(previous) : []);
    const nextCollections = new Set(collectionNsids(state));
    const tx = this.redis.multi().set(key, JSON.stringify(state), 'EX', 86400 * 30);

    for (const nsid of nextCollections) {
      tx.sadd(this.collectionIndexKey(nsid), state.did);
    }
    for (const nsid of previousCollections) {
      if (!nextCollections.has(nsid)) {
        tx.srem(this.collectionIndexKey(nsid), state.did);
      }
    }

    await tx.exec();
  }

  async delete(did: string): Promise<boolean> {
    const key = `${this.keyPrefix}${did}`;
    const rawPrevious = await this.redis.get(key);
    const previous = parseRepositoryStateBestEffort(rawPrevious);
    const tx = this.redis.multi().del(key).srem(this.indexKey, did);
    for (const nsid of previous ? collectionNsids(previous) : []) {
      tx.srem(this.collectionIndexKey(nsid), did);
    }
    const result = await tx.exec();
    const deleted = Number(result?.[0]?.[1] ?? 0);
    return deleted > 0;
  }

  async list(limit: number = 100, offset: number = 0): Promise<RepositoryState[]> {
    const safeLimit = Math.max(0, Math.trunc(limit));
    const safeOffset = Math.max(0, Math.trunc(offset));
    if (safeLimit === 0) return [];

    const dids = await this.scanRepositoryPage(safeLimit, safeOffset);
    const results: RepositoryState[] = [];

    for (let start = 0; start < dids.length; start += REPO_MGET_BATCH) {
      const batch = dids.slice(start, start + REPO_MGET_BATCH);
      if (batch.length === 0) continue;
      const rawStates: Array<string | null> = await this.redis.mget(
        ...batch.map((did) => `${this.keyPrefix}${did}`)
      );
      for (const raw of rawStates) {
        if (raw) results.push(JSON.parse(raw));
      }
    }

    return results;
  }

  async count(): Promise<number> {
    return this.redis.scard(this.indexKey);
  }

  async exists(did: string): Promise<boolean> {
    const key = `${this.keyPrefix}${did}`;
    return (await this.redis.exists(key)) > 0;
  }

  async getByCollection(nsid: string): Promise<RepositoryState[]> {
    const completeKey = this.collectionIndexCompleteKey(nsid);
    if ((await this.redis.get(completeKey)) !== '1') {
      await this.backfillCollectionIndex(nsid);
    }
    return this.loadCollectionIndex(nsid);
  }

  async getWithPendingCommits(): Promise<RepositoryState[]> {
    return [];
  }

  async transaction<T>(callback: (registry: AtprotoRepoRegistry) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async health(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async backfillCollectionIndex(nsid: string): Promise<void> {
    let cursor = '0';
    const collectionKey = this.collectionIndexKey(nsid);

    try {
      do {
        const response = await this.redis.sscan(this.indexKey, cursor, 'COUNT', REPO_SCAN_COUNT);
        const nextCursor = String(response?.[0] ?? '0');
        const scanned: string[] = Array.isArray(response?.[1])
          ? response[1].filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
          : [];

        // SSCAN COUNT is only a hint. Bound both state reads and index writes if
        // Redis returns an oversized compact-encoding page.
        for (let start = 0; start < scanned.length; start += REPO_MGET_BATCH) {
          const dids = scanned.slice(start, start + REPO_MGET_BATCH);
          if (dids.length === 0) continue;
          const rawStates: Array<string | null> = await this.redis.mget(
            ...dids.map((did) => `${this.keyPrefix}${did}`)
          );
          const matchingDids: string[] = [];
          for (let index = 0; index < dids.length; index += 1) {
            const raw = rawStates[index];
            if (!raw) continue;
            const state = JSON.parse(raw) as RepositoryState;
            if (state.collections.some((collection) => collection.nsid === nsid)) {
              matchingDids.push(dids[index]!);
            }
          }
          if (matchingDids.length > 0) {
            await this.redis.sadd(collectionKey, ...matchingDids);
          }
        }

        cursor = nextCursor;
      } while (cursor !== '0');

      // This marker is written only after a complete authoritative scan. All
      // subsequent register/update/delete operations maintain the index.
      await this.redis.set(this.collectionIndexCompleteKey(nsid), '1');
    } catch (error) {
      throw new RegistryError(
        RegistryErrorCode.PERSISTENCE_ERROR,
        `Repository collection index backfill failed for ${nsid}`,
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  private async loadCollectionIndex(nsid: string): Promise<RepositoryState[]> {
    const collectionKey = this.collectionIndexKey(nsid);
    const dids: string[] = await this.redis.smembers(collectionKey);
    const results: RepositoryState[] = [];
    const staleDids: string[] = [];

    for (let start = 0; start < dids.length; start += REPO_MGET_BATCH) {
      const batch = dids.slice(start, start + REPO_MGET_BATCH);
      if (batch.length === 0) continue;
      const rawStates: Array<string | null> = await this.redis.mget(
        ...batch.map((did) => `${this.keyPrefix}${did}`)
      );
      for (let index = 0; index < batch.length; index += 1) {
        const did = batch[index]!;
        const raw = rawStates[index];
        if (!raw) {
          staleDids.push(did);
          continue;
        }
        const state = JSON.parse(raw) as RepositoryState;
        if (state.collections.some((collection) => collection.nsid === nsid)) {
          results.push(state);
        } else {
          // Authoritative state wins over a stale secondary-index member. This
          // also makes concurrent backfill/update/delete races correctness-safe.
          staleDids.push(did);
        }
      }
    }

    for (let start = 0; start < staleDids.length; start += REPO_MGET_BATCH) {
      const batch = staleDids.slice(start, start + REPO_MGET_BATCH);
      if (batch.length > 0) await this.redis.srem(collectionKey, ...batch);
    }

    return results;
  }

  private async scanRepositoryPage(limit: number, offset: number): Promise<string[]> {
    let cursor = '0';
    let uniqueIndex = 0;
    const selected: string[] = [];
    const sessionKey = `${REPO_SCAN_SESSION_PREFIX}${randomUUID()}`;
    const sentinel = `\u0000atproto-repo-scan:${randomUUID()}`;
    let opened = false;

    try {
      const openResult = await this.redis.eval(
        OPEN_REPO_SCAN_SESSION_LUA,
        1,
        sessionKey,
        sentinel,
        String(REPO_SCAN_SESSION_TTL_MS)
      );
      if (Number(openResult) !== 1) {
        throw new Error('Redis did not initialize repository scan session');
      }
      opened = true;

      do {
        const response = await this.redis.sscan(this.indexKey, cursor, 'COUNT', REPO_SCAN_COUNT);
        const nextCursor = String(response?.[0] ?? '0');
        const scanned: string[] = Array.isArray(response?.[1])
          ? response[1].filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
          : [];

        for (let start = 0; start < scanned.length; start += REPO_MGET_BATCH) {
          const chunk = scanned.slice(start, start + REPO_MGET_BATCH);
          const fresh = await this.dedupeScanDids(sessionKey, sentinel, chunk);
          for (const did of fresh) {
            if (uniqueIndex < offset) {
              uniqueIndex += 1;
              continue;
            }
            selected.push(did);
            uniqueIndex += 1;
            if (selected.length >= limit) return selected;
          }
        }

        cursor = nextCursor;
      } while (cursor !== '0');

      return selected;
    } catch (error) {
      throw new RegistryError(
        RegistryErrorCode.PERSISTENCE_ERROR,
        'Repository registry scan failed',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      if (opened) {
        try {
          await this.redis.del(sessionKey);
        } catch {
          // Best effort: the atomic open operation always attaches a TTL.
        }
      }
    }
  }

  private async dedupeScanDids(
    sessionKey: string,
    sentinel: string,
    dids: string[]
  ): Promise<string[]> {
    if (dids.length === 0) return [];
    if (dids.length > REPO_MGET_BATCH) {
      throw new Error('Repository scan de-duplication batch exceeded configured bound');
    }

    const result = await this.redis.eval(
      DEDUPE_REPO_SCAN_IDS_LUA,
      1,
      sessionKey,
      sentinel,
      String(REPO_SCAN_SESSION_TTL_MS),
      ...dids
    );
    if (!Array.isArray(result) || result.some((did) => typeof did !== 'string')) {
      throw new Error('Repository scan de-duplication returned invalid Redis response');
    }
    return result as string[];
  }

  private collectionIndexKey(nsid: string): string {
    return `${COLLECTION_INDEX_PREFIX}${encodeURIComponent(nsid)}`;
  }

  private collectionIndexCompleteKey(nsid: string): string {
    return `${COLLECTION_INDEX_COMPLETE_PREFIX}${encodeURIComponent(nsid)}`;
  }
}

function collectionNsids(state: RepositoryState): string[] {
  return Array.from(new Set(
    state.collections
      .map((collection) => collection.nsid)
      .filter((nsid): nsid is string => typeof nsid === 'string' && nsid.length > 0)
  ));
}

function parseRepositoryStateBestEffort(raw: string | null): RepositoryState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepositoryState;
  } catch {
    return null;
  }
}
