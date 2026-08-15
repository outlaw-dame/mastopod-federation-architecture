import { describe, expect, it, vi } from 'vitest';
import type { IdentityBinding } from './IdentityBinding.js';
import { RedisIdentityBindingRepository } from './RedisIdentityBindingRepository.js';

function binding(
  id: string,
  contextId = 'ctx-a',
  status: 'active' | 'suspended' | 'deactivated' = 'active',
): IdentityBinding {
  return {
    canonicalAccountId: id,
    contextId,
    webId: `https://pod.example/${id}/profile/card#me`,
    activityPubActorUri: `https://pod.example/${id}`,
    atprotoDid: `did:plc:${id}`,
    atprotoHandle: `${id}.pod.example`,
    canonicalDidMethod: null,
    atprotoPdsEndpoint: 'https://pds.example',
    apSigningKeyRef: `ap:${id}`,
    atSigningKeyRef: `at:${id}`,
    atRotationKeyRef: `rotation:${id}`,
    plc: null,
    didWeb: null,
    accountLinks: {
      apAlsoKnownAs: [],
      atAlsoKnownAs: [],
      relMe: [],
      webIdSameAs: [],
      webIdAccounts: [],
    },
    status,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

function makeScanRedis(
  pages: Array<[string, string[]]>,
  values: Map<string, IdentityBinding>,
) {
  let page = 0;
  return {
    sscan: vi.fn(async () => pages[page++] ?? ['0', []]),
    mget: vi.fn(async (...keys: string[]) =>
      keys.map(key => {
        const id = key.replace(/^identity:binding:/u, '');
        const value = values.get(id);
        return value ? JSON.stringify(value) : null;
      }),
    ),
    smembers: vi.fn(async () => {
      throw new Error('SMEMBERS must not be used by bounded scans');
    }),
    get: vi.fn(async () => {
      throw new Error('per-binding GET must not be used by bounded scans');
    }),
  };
}

describe('RedisIdentityBindingRepository bounded reads', () => {
  it('stops scanning as soon as a paginated filtered result is satisfied', async () => {
    const values = new Map<string, IdentityBinding>([
      ['a', binding('a', 'ctx-target')],
      ['b', binding('b', 'ctx-other')],
      ['c', binding('c', 'ctx-target')],
      ['d', binding('d', 'ctx-target')],
    ]);
    const redis = makeScanRedis(
      [
        ['17', ['a', 'b', 'c']],
        ['0', ['d']],
      ],
      values,
    );
    const repository = new RedisIdentityBindingRepository(redis);

    const result = await repository.listByContext('ctx-target', 1, 0);

    expect(result.map(item => item.canonicalAccountId)).toEqual(['a']);
    expect(redis.sscan).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.smembers).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('batches full counts and de-duplicates members repeated by SSCAN', async () => {
    const values = new Map<string, IdentityBinding>([
      ['a', binding('a', 'ctx-target')],
      ['b', binding('b', 'ctx-other')],
      ['c', binding('c', 'ctx-target')],
      ['d', binding('d', 'ctx-target')],
    ]);
    const redis = makeScanRedis(
      [
        ['17', ['a', 'b', 'c']],
        ['0', ['c', 'd']],
      ],
      values,
    );
    const repository = new RedisIdentityBindingRepository(redis);

    const count = await repository.countByContext('ctx-target');

    expect(count).toBe(3);
    expect(redis.sscan).toHaveBeenCalledTimes(2);
    expect(redis.mget).toHaveBeenCalledTimes(2);
    expect(redis.mget.mock.calls[1]).toEqual(['identity:binding:d']);
    expect(redis.smembers).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('chunks getBatch instead of creating one Redis lookup per account', async () => {
    const ids = Array.from({ length: 260 }, (_, index) => `account-${index}`);
    const values = new Map(ids.map(id => [id, binding(id)]));
    const redis = {
      mget: vi.fn(async (...keys: string[]) =>
        keys.map(key => {
          const id = key.replace(/^identity:binding:/u, '');
          return JSON.stringify(values.get(id));
        }),
      ),
    };
    const repository = new RedisIdentityBindingRepository(redis);

    const result = await repository.getBatch(ids);

    expect(result.size).toBe(260);
    expect(redis.mget).toHaveBeenCalledTimes(3);
    expect(redis.mget.mock.calls.map(call => call.length)).toEqual([128, 128, 4]);
  });
});
