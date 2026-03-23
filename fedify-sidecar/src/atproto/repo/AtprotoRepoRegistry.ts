/**
 * V6.5 ATProto Repository Registry - Multi-Repository Management
 *
 * Manages multiple ATProto repositories (one per DID).
 * Provides efficient lookup and state management.
 *
 * Uses Redis for persistence and in-memory cache for performance.
 */

import { RepositoryState } from './AtprotoRepoState.js';

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
  /**
   * Register a new repository
   *
   * @param state - Repository state
   * @throws RegistryError if already exists or persistence fails
   */
  register(state: RepositoryState): Promise<void>;

  /**
   * Get repository by DID
   *
   * @param did - Repository DID
   * @returns Repository state or null if not found
   * @throws RegistryError on persistence error
   */
  getByDid(did: string): Promise<RepositoryState | null>;

  /**
   * Update repository state
   *
   * @param state - Updated repository state
   * @throws RegistryError if not found or persistence fails
   */
  update(state: RepositoryState): Promise<void>;

  /**
   * Delete repository
   *
   * @param did - Repository DID
   * @returns true if deleted, false if not found
   * @throws RegistryError on persistence error
   */
  delete(did: string): Promise<boolean>;

  /**
   * List all repositories
   *
   * @param limit - Maximum results (default 100)
   * @param offset - Pagination offset (default 0)
   * @returns Array of repository states
   * @throws RegistryError on persistence error
   */
  list(limit?: number, offset?: number): Promise<RepositoryState[]>;

  /**
   * Count total repositories
   *
   * @returns Total count
   * @throws RegistryError on persistence error
   */
  count(): Promise<number>;

  /**
   * Check if repository exists
   *
   * @param did - Repository DID
   * @returns true if exists
   * @throws RegistryError on persistence error
   */
  exists(did: string): Promise<boolean>;

  /**
   * Get repositories by collection
   *
   * @param nsid - Collection NSID
   * @returns Array of repository states
   * @throws RegistryError on persistence error
   */
  getByCollection(nsid: string): Promise<RepositoryState[]>;

  /**
   * Get repositories with pending commits
   *
   * @returns Array of repository states
   * @throws RegistryError on persistence error
   */
  getWithPendingCommits(): Promise<RepositoryState[]>;

  /**
   * Transaction support
   *
   * @param callback - Function to execute within transaction
   * @throws RegistryError on transaction failure
   */
  transaction<T>(callback: (registry: AtprotoRepoRegistry) => Promise<T>): Promise<T>;

  /**
   * Health check
   *
   * @returns true if registry is healthy
   */
  health(): Promise<boolean>;
  
  /**
   * Get repository state (alias for getByDid used in Phase 3/4/5)
   */
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
    // In-memory implementation doesn't track pending commits
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

    // Check if already exists
    const exists = await this.redis.exists(key);
    if (exists) {
      throw new RegistryError(
        RegistryErrorCode.ALREADY_EXISTS,
        `Repository already exists: ${state.did}`
      );
    }

    // Store repository state
    await this.redis.set(key, JSON.stringify(state), 'EX', 86400 * 30); // 30 days TTL

    // Add to index
    await this.redis.sadd(this.indexKey, state.did);
  }

  async getByDid(did: string): Promise<RepositoryState | null> {
    const key = `${this.keyPrefix}${did}`;
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    return JSON.parse(data);
  }
  
  async getRepoState(did: string): Promise<RepositoryState | null> {
    return this.getByDid(did);
  }

  async update(state: RepositoryState): Promise<void> {
    const key = `${this.keyPrefix}${state.did}`;

    // Check if exists
    const exists = await this.redis.exists(key);
    if (!exists) {
      throw new RegistryError(
        RegistryErrorCode.NOT_FOUND,
        `Repository not found: ${state.did}`
      );
    }

    // Update repository state
    await this.redis.set(key, JSON.stringify(state), 'EX', 86400 * 30);
  }

  async delete(did: string): Promise<boolean> {
    const key = `${this.keyPrefix}${did}`;
    const deleted = await this.redis.del(key);
    await this.redis.srem(this.indexKey, did);
    return deleted > 0;
  }

  async list(limit: number = 100, offset: number = 0): Promise<RepositoryState[]> {
    const dids = await this.redis.smembers(this.indexKey);
    const slice = dids.slice(offset, offset + limit);

    const results: RepositoryState[] = [];
    for (const did of slice) {
      const state = await this.getByDid(did);
      if (state) {
        results.push(state);
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
    // Would require additional tracking in Redis
    return [];
  }

  async transaction<T>(callback: (registry: AtprotoRepoRegistry) => Promise<T>): Promise<T> {
    // Redis transactions would be implemented here
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
}
