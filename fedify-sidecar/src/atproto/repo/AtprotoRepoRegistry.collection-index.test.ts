import { describe, expect, it, vi } from 'vitest';
import { RedisAtprotoRepoRegistry, RegistryErrorCode } from './AtprotoRepoRegistry.js';
import type { RepositoryState } from './AtprotoRepoState.js';

const POST = 'app.bsky.feed.post';
const LIKE = 'app.bsky.feed.like';

function repoState(did: string, nsids: string[]): RepositoryState {
  const now = '2026-08-15T00:00:00.000Z';
  return {
    did,
    rootCid: null,
    rev: '0',
    commits: [],
    collections: nsids.map((nsid) => ({
      nsid,
      recordCount: 1,
      lastUpdated: now,
    })),
    totalRecords: nsids.length,
    sizeBytes: 0,
    status: 'active',
    lastCommitAt: now,
    snapshotAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

class MemoryMulti {
  private readonly operations: Array<() => unknown> = [];

  public constructor(private readonly redis: MemoryRedis) {}

  set(key: string, value: string, ..._args: unknown[]): this {
    this.operations.push(() => {
      this.redis.strings.set(key, value);
      return 'OK';
    });
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    this.operations.push(() => this.redis.addSetMembers(key, members));
    return this;
  }

  srem(key: string, ...members: string[]): this {
    this.operations.push(() => this.redis.removeSetMembers(key, members));
    return this;
  }

  del(key: string): this {
    this.operations.push(() => Number(this.redis.strings.delete(key)));
    return this;
  }

  async exec(): Promise<Array<[null, unknown]>> {
    return this.operations.map((operation) => [null, operation()]);
  }
}

class MemoryRedis {
  public readonly strings = new Map<string, string>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly mgetCalls: string[][] = [];
  public readonly saddCalls: Array<[string, ...string[]]> = [];
  public readonly sremCalls: Array<[string, ...string[]]> = [];
  public readonly sscan = vi.fn(async (_key: string, cursor: string) => {
    const members = [...(this.sets.get('atproto:repos') ?? new Set())];
    if (cursor !== '0') return ['0', []] as [string, string[]];
    return ['0', members] as [string, string[]];
  });

  async exists(key: string): Promise<number> {
    return Number(this.strings.has(key));
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.mgetCalls.push(keys);
    return keys.map((key) => this.strings.get(key) ?? null);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.saddCalls.push([key, ...members]);
    return this.addSetMembers(key, members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    this.sremCalls.push([key, ...members]);
    return this.removeSetMembers(key, members);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set())];
  }

  multi(): MemoryMulti {
    return new MemoryMulti(this);
  }

  addSetMembers(key: string, members: string[]): number {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (set.has(member)) continue;
      set.add(member);
      added += 1;
    }
    return added;
  }

  removeSetMembers(key: string, members: string[]): number {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  seed(state: RepositoryState): void {
    this.strings.set(`atproto:repo:${state.did}`, JSON.stringify(state));
    this.addSetMembers('atproto:repos', [state.did]);
  }
}

function collectionKey(nsid: string): string {
  return `atproto:repos:collection:${encodeURIComponent(nsid)}`;
}

function completeKey(nsid: string): string {
  return `atproto:repos:collection-complete:${encodeURIComponent(nsid)}`;
}

describe('RedisAtprotoRepoRegistry collection secondary index', () => {
  it('backfills legacy repositories before marking the collection index complete', async () => {
    const redis = new MemoryRedis();
    redis.seed(repoState('did:plc:a', [POST]));
    redis.seed(repoState('did:plc:b', [LIKE]));
    redis.seed(repoState('did:plc:c', [POST, LIKE]));
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    const result = await registry.getByCollection(POST);

    expect(result.map((state) => state.did).sort()).toEqual(['did:plc:a', 'did:plc:c']);
    expect(redis.sets.get(collectionKey(POST))).toEqual(new Set(['did:plc:a', 'did:plc:c']));
    expect(redis.strings.get(completeKey(POST))).toBe('1');
    expect(redis.sscan).toHaveBeenCalledTimes(1);
  });

  it('uses the completed secondary index on later reads instead of scanning all repositories again', async () => {
    const redis = new MemoryRedis();
    redis.seed(repoState('did:plc:a', [POST]));
    redis.seed(repoState('did:plc:b', [LIKE]));
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    await registry.getByCollection(POST);
    redis.sscan.mockClear();
    const result = await registry.getByCollection(POST);

    expect(result.map((state) => state.did)).toEqual(['did:plc:a']);
    expect(redis.sscan).not.toHaveBeenCalled();
  });

  it('hard-chunks an oversized legacy backfill response at 128 repository states', async () => {
    const redis = new MemoryRedis();
    const dids = Array.from({ length: 260 }, (_, index) => `did:plc:${index}`);
    for (const did of dids) redis.seed(repoState(did, [POST]));
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    const result = await registry.getByCollection(POST);

    expect(result).toHaveLength(260);
    // Three bounded reads during backfill plus three bounded reads from the completed index.
    expect(redis.mgetCalls.map((batch) => batch.length)).toEqual([128, 128, 4, 128, 128, 4]);
    expect(redis.saddCalls.filter(([key]) => key === collectionKey(POST)).map((call) => call.length - 1))
      .toEqual([128, 128, 4]);
  });

  it('maintains collection memberships across register, update, and delete', async () => {
    const redis = new MemoryRedis();
    // Pretend both collection indexes were already fully migrated.
    redis.strings.set(completeKey(POST), '1');
    redis.strings.set(completeKey(LIKE), '1');
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    await registry.register(repoState('did:plc:a', [POST]));
    expect(redis.sets.get(collectionKey(POST))).toContain('did:plc:a');

    await registry.update(repoState('did:plc:a', [LIKE]));
    expect(redis.sets.get(collectionKey(POST))?.has('did:plc:a')).toBe(false);
    expect(redis.sets.get(collectionKey(LIKE))).toContain('did:plc:a');

    await registry.delete('did:plc:a');
    expect(redis.sets.get(collectionKey(LIKE))?.has('did:plc:a')).toBe(false);
    expect(redis.sets.get('atproto:repos')?.has('did:plc:a')).toBe(false);
  });

  it('filters and prunes stale secondary-index members using authoritative repository state', async () => {
    const redis = new MemoryRedis();
    redis.strings.set(completeKey(POST), '1');
    redis.seed(repoState('did:plc:current', [POST]));
    redis.seed(repoState('did:plc:moved', [LIKE]));
    redis.addSetMembers(collectionKey(POST), [
      'did:plc:current',
      'did:plc:moved',
      'did:plc:expired',
    ]);
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    const result = await registry.getByCollection(POST);

    expect(result.map((state) => state.did)).toEqual(['did:plc:current']);
    expect(redis.sets.get(collectionKey(POST))).toEqual(new Set(['did:plc:current']));
  });

  it('never writes the completion marker when legacy backfill fails partway through', async () => {
    const redis = new MemoryRedis();
    redis.seed(repoState('did:plc:a', [POST]));
    redis.sscan
      .mockResolvedValueOnce(['7', ['did:plc:a']] as [string, string[]])
      .mockRejectedValueOnce(new Error('redis unavailable'));
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    const error = await registry.getByCollection(POST).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: RegistryErrorCode.PERSISTENCE_ERROR });
    expect(redis.strings.has(completeKey(POST))).toBe(false);
  });
});
