import { describe, expect, it, vi } from 'vitest';
import {
  RedisAtprotoRepoRegistry,
  RegistryErrorCode,
} from './AtprotoRepoRegistry.js';
import type { RepositoryState } from './AtprotoRepoState.js';

function repoState(did: string): RepositoryState {
  const now = '2026-08-15T00:00:00.000Z';
  return {
    did,
    rootCid: null,
    rev: '0',
    commits: [],
    collections: [],
    totalRecords: 0,
    sizeBytes: 0,
    status: 'active',
    lastCommitAt: now,
    snapshotAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRedis(
  pages: Array<[string, string[]]>,
  states: Map<string, RepositoryState>,
) {
  let pageIndex = 0;
  const sessions = new Map<string, Set<string>>();

  return {
    sscan: vi.fn(async () => pages[pageIndex++] ?? ['0', []]),
    mget: vi.fn(async (...keys: string[]) =>
      keys.map((key) => {
        const did = key.replace(/^atproto:repo:/u, '');
        const state = states.get(did);
        return state ? JSON.stringify(state) : null;
      }),
    ),
    smembers: vi.fn(async () => {
      throw new Error('SMEMBERS must not be used by bounded list pagination');
    }),
    get: vi.fn(async () => {
      throw new Error('per-repository GET must not be used by bounded list pagination');
    }),
    del: vi.fn(async (key: string) => Number(sessions.delete(key))),
    eval: vi.fn(async (
      _script: string,
      _keyCount: number,
      sessionKey: string,
      sentinel: string,
      _ttl: string,
      ...dids: string[]
    ) => {
      if (dids.length === 0) {
        sessions.set(sessionKey, new Set([sentinel]));
        return 1;
      }

      const session = sessions.get(sessionKey);
      if (!session || !session.has(sentinel)) {
        throw new Error('ATPROTO_REPO_SCAN_SESSION_EXPIRED');
      }

      const fresh: string[] = [];
      for (const did of dids) {
        if (session.has(did)) continue;
        session.add(did);
        fresh.push(did);
      }
      return fresh;
    }),
  };
}

describe('RedisAtprotoRepoRegistry bounded list pagination', () => {
  it('stops scanning once a small page is satisfied and avoids SMEMBERS/per-DID GET', async () => {
    const states = new Map([
      ['did:plc:a', repoState('did:plc:a')],
      ['did:plc:b', repoState('did:plc:b')],
      ['did:plc:c', repoState('did:plc:c')],
      ['did:plc:d', repoState('did:plc:d')],
    ]);
    const redis = makeRedis(
      [
        ['17', ['did:plc:a', 'did:plc:b', 'did:plc:c']],
        ['0', ['did:plc:d']],
      ],
      states,
    );
    const registry = new RedisAtprotoRepoRegistry(redis);

    const result = await registry.list(1, 0);

    expect(result.map((state) => state.did)).toEqual(['did:plc:a']);
    expect(redis.sscan).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget.mock.calls[0]).toEqual(['atproto:repo:did:plc:a']);
    expect(redis.smembers).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('does not let repeated SSCAN members consume offset or page slots', async () => {
    const states = new Map([
      ['did:plc:a', repoState('did:plc:a')],
      ['did:plc:b', repoState('did:plc:b')],
      ['did:plc:c', repoState('did:plc:c')],
      ['did:plc:d', repoState('did:plc:d')],
    ]);
    const redis = makeRedis(
      [
        ['17', ['did:plc:a', 'did:plc:b', 'did:plc:c']],
        ['0', ['did:plc:c', 'did:plc:d']],
      ],
      states,
    );
    const registry = new RedisAtprotoRepoRegistry(redis);

    const result = await registry.list(2, 2);

    expect(result.map((state) => state.did)).toEqual(['did:plc:c', 'did:plc:d']);
    expect(redis.sscan).toHaveBeenCalledTimes(2);
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget.mock.calls[0]).toEqual([
      'atproto:repo:did:plc:c',
      'atproto:repo:did:plc:d',
    ]);
  });

  it('chunks oversized SSCAN responses before de-duplication and MGET', async () => {
    const dids = Array.from({ length: 260 }, (_, index) => `did:plc:repo-${index}`);
    const states = new Map(dids.map((did) => [did, repoState(did)]));
    const redis = makeRedis([['0', dids]], states);
    const registry = new RedisAtprotoRepoRegistry(redis);

    const result = await registry.list(260, 0);

    expect(result).toHaveLength(260);
    expect(redis.sscan).toHaveBeenCalledTimes(1);
    // One eval opens the scan session; three more de-duplicate 128/128/4.
    expect(redis.eval).toHaveBeenCalledTimes(4);
    const dedupeArgumentCounts = redis.eval.mock.calls.slice(1).map((call) => call.slice(5).length);
    expect(dedupeArgumentCounts).toEqual([128, 128, 4]);
    expect(redis.mget).toHaveBeenCalledTimes(3);
    expect(redis.mget.mock.calls.map((call) => call.length)).toEqual([128, 128, 4]);
  });

  it('preserves slice-then-load semantics when a selected repository state is stale', async () => {
    const states = new Map([
      ['did:plc:a', repoState('did:plc:a')],
      // did:plc:b intentionally has no state even though it is in the index.
      ['did:plc:c', repoState('did:plc:c')],
    ]);
    const redis = makeRedis([['0', ['did:plc:a', 'did:plc:b', 'did:plc:c']]], states);
    const registry = new RedisAtprotoRepoRegistry(redis);

    const result = await registry.list(2, 0);

    // The old implementation sliced [a,b] first and then dropped missing b;
    // it did not fetch c to fill the page. Keep that exact behavior.
    expect(result.map((state) => state.did)).toEqual(['did:plc:a']);
    expect(redis.mget.mock.calls[0]).toEqual([
      'atproto:repo:did:plc:a',
      'atproto:repo:did:plc:b',
    ]);
  });

  it('fails closed and cleans up when the Redis-side scan session disappears', async () => {
    const states = new Map([
      ['did:plc:a', repoState('did:plc:a')],
      ['did:plc:b', repoState('did:plc:b')],
    ]);
    const redis = makeRedis(
      [
        ['17', ['did:plc:a']],
        ['0', ['did:plc:b']],
      ],
      states,
    );
    redis.eval
      .mockImplementationOnce(async () => 1)
      .mockImplementationOnce(async (
        _script: string,
        _keyCount: number,
        _sessionKey: string,
        _sentinel: string,
        _ttl: string,
        ...dids: string[]
      ) => dids)
      .mockRejectedValueOnce(new Error('ATPROTO_REPO_SCAN_SESSION_EXPIRED'));
    const registry = new RedisAtprotoRepoRegistry(redis);

    const error = await registry.list(2, 0).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: RegistryErrorCode.PERSISTENCE_ERROR });
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('returns an empty page without touching Redis when limit is zero', async () => {
    const redis = makeRedis([], new Map());
    const registry = new RedisAtprotoRepoRegistry(redis);

    await expect(registry.list(0, 1000)).resolves.toEqual([]);
    expect(redis.sscan).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.mget).not.toHaveBeenCalled();
  });
});
