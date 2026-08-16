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

/**
 * Repository registry error codes
 */
export enum RegistryErrorCode {
  /**
   * Repository not found
   */
  NOT_FOUND = 'NOT_FOUND',

  /**
   * Repository already exists
   */
  ALREADY_EXISTS = 'ALREADY_EXISTS',

  /**
   * Persistence error
   */
  PERSISTENCE_ERROR = 'PERSISTENCE_ERROR',

  /**
   * Validation error
   */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

/**
 * Registry error
 */
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

/**
 * ATProto Repository Registry
 *
 * Manages repository state across multiple DIDs.
 */
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

/**
 * In-memory repository registry (for testing/caching)
 */
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

/**
 * Redis-backed repository registry
 */
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

    await this.redis.set(key, JSON.stringify(state), 'EX', 86400 * 30);
    await this.redis.sadd(this.indexKey, state.did);
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
    const exists = await this.redis.exists(key);
    if (!exists) {
      throw new RegistryError(
        RegistryErrorCode.NOT_FOUND,
        `Repository not found: ${state.did}`
      );
    }
    await this.redis.set(key, JSON.stringify(state), 'EX', 86400 * 30);
  }

  async delete(did: string): Promise<boolean> {
    const key = `${this.keyPrefix}${did}`;
    const deleted = await this.redis.del(key);
    await this.redis.srem(this.indexKey, did);
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
    // This API returns the complete matching population. Keep the current
    // authority semantics until a collection secondary index has an explicit
    // migration/backfill design; changing it here could make legacy repos invisible.
    const dids = await this.redis.smembers(this.indexKey);
    const results: RepositoryState[] = [];

    for (const did of dids) {
      const state = await this.getByDid(did);
      if (state && state.collections.some((c) => c.nsid === nsid)) {
        results.push(state);
      }
    }

    return results;
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

        // COUNT is only a work hint. Bound the de-duplication command even when
        // Redis returns an oversized compact-encoding page.
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
}
