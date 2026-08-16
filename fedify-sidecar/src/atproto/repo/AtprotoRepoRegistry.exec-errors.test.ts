import { describe, expect, it, vi } from 'vitest';
import { RedisAtprotoRepoRegistry, RegistryErrorCode } from './AtprotoRepoRegistry.js';
import type { RepositoryState } from './AtprotoRepoState.js';

const POST = 'app.bsky.feed.post';
const LIKE = 'app.bsky.feed.like';

function state(did: string, nsids: string[]): RepositoryState {
  const now = '2026-08-15T00:00:00.000Z';
  return {
    did,
    rootCid: null,
    rev: '0',
    commits: [],
    collections: nsids.map((nsid) => ({ nsid, recordCount: 1, lastUpdated: now })),
    totalRecords: nsids.length,
    sizeBytes: 0,
    status: 'active',
    lastCommitAt: now,
    snapshotAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function transactionWithResult(result: unknown) {
  const tx: any = {
    set: vi.fn(() => tx),
    sadd: vi.fn(() => tx),
    srem: vi.fn(() => tx),
    del: vi.fn(() => tx),
    exec: vi.fn(async () => result),
  };
  return tx;
}

describe('RedisAtprotoRepoRegistry Redis transaction hardening', () => {
  it('fails closed and invalidates affected collection indexes when EXEC reports a per-command error', async () => {
    const did = 'did:plc:alice';
    const previous = state(did, [POST]);
    const next = state(did, [LIKE]);
    const tx = transactionWithResult([
      [null, 'OK'],
      [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null],
      [null, 1],
    ]);
    const redis = {
      get: vi.fn(async () => JSON.stringify(previous)),
      multi: vi.fn(() => tx),
      del: vi.fn(async (..._keys: string[]) => 2),
    };
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    const error = await registry.update(next).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: RegistryErrorCode.PERSISTENCE_ERROR });
    expect(redis.del).toHaveBeenCalledWith(
      `atproto:repos:collection-complete:${encodeURIComponent(POST)}`,
      `atproto:repos:collection-complete:${encodeURIComponent(LIKE)}`,
    );
  });

  it('invalidates collection completeness when EXEC rejects and preserves the original failure as cause metadata', async () => {
    const did = 'did:plc:bob';
    const tx = transactionWithResult(null);
    tx.exec.mockRejectedValueOnce(new Error('connection reset'));
    const redis = {
      exists: vi.fn(async () => 0),
      multi: vi.fn(() => tx),
      del: vi.fn(async (..._keys: string[]) => 1),
    };
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    const error = await registry.register(state(did, [POST])).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: RegistryErrorCode.PERSISTENCE_ERROR,
      details: { cause: 'connection reset' },
    });
    expect(redis.del).toHaveBeenCalledWith(
      `atproto:repos:collection-complete:${encodeURIComponent(POST)}`,
    );
  });

  it('treats a null EXEC response as persistence failure instead of silently succeeding', async () => {
    const did = 'did:plc:carol';
    const tx = transactionWithResult(null);
    const redis = {
      exists: vi.fn(async () => 0),
      multi: vi.fn(() => tx),
      del: vi.fn(async (..._keys: string[]) => 1),
    };
    const registry = new RedisAtprotoRepoRegistry(redis as any);

    await expect(registry.register(state(did, [POST]))).rejects.toMatchObject({
      code: RegistryErrorCode.PERSISTENCE_ERROR,
    });
    expect(redis.del).toHaveBeenCalledTimes(1);
  });
});
