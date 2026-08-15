import { describe, expect, it, vi } from 'vitest';
import { RedisAtAliasStore, type AtAliasRecord } from './AtAliasStore.js';

function alias(name: string, did: string, deletedAt?: string): AtAliasRecord {
  return {
    canonicalRefId: `canonical:${name}`,
    canonicalType: 'post',
    did,
    collection: 'app.bsky.feed.post',
    rkey: name,
    atUri: `at://${did}/app.bsky.feed.post/${name}`,
    createdAt: '2026-08-14T20:00:00.000Z',
    updatedAt: deletedAt ?? '2026-08-14T20:00:00.000Z',
    deletedAt: deletedAt ?? null,
  };
}

describe('RedisAtAliasStore bounded enumeration', () => {
  it('uses SCAN plus page MGET for listByDid and never Redis KEYS', async () => {
    const alice = alias('alice-1', 'did:plc:alice');
    const bob = alias('bob-1', 'did:plc:bob');
    const aliceTwo = alias('alice-2', 'did:plc:alice');
    const redis = {
      scan: vi
        .fn()
        .mockResolvedValueOnce(['17', ['at:alias:canonical:a', 'at:alias:canonical:b']])
        .mockResolvedValueOnce(['0', ['at:alias:canonical:c']]),
      mget: vi
        .fn()
        .mockResolvedValueOnce([JSON.stringify(alice), JSON.stringify(bob)])
        .mockResolvedValueOnce([JSON.stringify(aliceTwo)]),
      keys: vi.fn(),
      get: vi.fn(),
    };

    const store = new RedisAtAliasStore(redis);
    const result = await store.listByDid('did:plc:alice');

    expect(result).toEqual([alice, aliceTwo]);
    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.mget).toHaveBeenCalledTimes(2);
    expect(redis.keys).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('deduplicates a key repeated by SCAN on a later page', async () => {
    const first = alias('first', 'did:plc:alice');
    const second = alias('second', 'did:plc:alice');
    const redis = {
      scan: vi
        .fn()
        .mockResolvedValueOnce(['7', ['at:alias:canonical:first']])
        .mockResolvedValueOnce([
          '0',
          ['at:alias:canonical:first', 'at:alias:canonical:second'],
        ]),
      mget: vi
        .fn()
        .mockResolvedValueOnce([JSON.stringify(first)])
        .mockResolvedValueOnce([JSON.stringify(second)]),
    };

    const store = new RedisAtAliasStore(redis);
    const result = await store.listActive();

    expect(result).toEqual([first, second]);
    expect(redis.mget).toHaveBeenNthCalledWith(1, 'at:alias:canonical:first');
    expect(redis.mget).toHaveBeenNthCalledWith(2, 'at:alias:canonical:second');
  });

  it('filters active aliases after bounded page reads', async () => {
    const active = alias('active', 'did:plc:alice');
    const deleted = alias('deleted', 'did:plc:alice', '2026-08-14T21:00:00.000Z');
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', ['at:alias:canonical:a', 'at:alias:canonical:b']]),
      mget: vi.fn().mockResolvedValue([JSON.stringify(active), JSON.stringify(deleted)]),
      keys: vi.fn(),
    };

    const store = new RedisAtAliasStore(redis);
    const result = await store.listActive();

    expect(result).toEqual([active]);
    expect(redis.keys).not.toHaveBeenCalled();
  });

  it('skips aliases removed between SCAN and MGET', async () => {
    const active = alias('active', 'did:plc:alice');
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', ['at:alias:canonical:gone', 'at:alias:canonical:a']]),
      mget: vi.fn().mockResolvedValue([null, JSON.stringify(active)]),
    };

    const store = new RedisAtAliasStore(redis);
    await expect(store.listActive()).resolves.toEqual([active]);
  });
});
