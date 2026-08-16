import { describe, expect, it, vi } from 'vitest';
import { OAuthRefreshTokenStore } from './OAuthRedisStores.js';
import type { OAuthRefreshTokenRecord } from './OAuthTypes.js';

function tokenRecord(
  tokenId: string,
  familyId = 'family-1',
  expiresAtEpochSec = Math.floor(Date.now() / 1000) + 3600,
): OAuthRefreshTokenRecord {
  return {
    refreshTokenId: tokenId,
    familyId,
    grantId: 'grant-1',
    subjectDid: 'did:plc:alice',
    canonicalAccountId: 'account:alice',
    clientId: 'https://client.example/metadata.json',
    scope: 'atproto',
    issuedAtEpochSec: Math.floor(Date.now() / 1000) - 10,
    expiresAtEpochSec,
  };
}

class FakeMulti {
  public readonly writes: Array<{ key: string; value: string; ttl: number }> = [];

  set(key: string, value: string, token: string, ttl: number): this {
    expect(token).toBe('EX');
    this.writes.push({ key, value, ttl });
    return this;
  }

  async exec(): Promise<Array<[null, string]>> {
    return this.writes.map(() => [null, 'OK']);
  }
}

class FakeRedis {
  public readonly smembers = vi.fn(async () => {
    throw new Error('revokeFamily must not materialize the full family set');
  });
  public readonly get = vi.fn(async () => {
    throw new Error('revokeFamily must not issue sequential GETs');
  });
  public readonly mgetCalls: string[][] = [];
  public readonly transactions: FakeMulti[] = [];
  private pageIndex = 0;

  constructor(
    private readonly pages: Array<[string, string[]]>,
    private readonly records: Map<string, string | null>,
  ) {}

  sscan = vi.fn(async () => {
    const page = this.pages[this.pageIndex] ?? ['0', []];
    this.pageIndex += 1;
    return page;
  });

  mget = vi.fn(async (...keys: string[]) => {
    this.mgetCalls.push(keys);
    return keys.map((key) => this.records.get(key) ?? null);
  });

  multi = vi.fn(() => {
    const tx = new FakeMulti();
    this.transactions.push(tx);
    return tx;
  });
}

describe('OAuthRefreshTokenStore bounded family revocation', () => {
  it('hard-chunks oversized SSCAN responses and batches writes', async () => {
    const keys = Array.from({ length: 260 }, (_, index) => `at:oauth:refresh:token-${index}`);
    const records = new Map(keys.map((key, index) => [
      key,
      JSON.stringify(tokenRecord(`token-${index}`)),
    ]));
    const redis = new FakeRedis([['0', keys]], records);
    const store = new OAuthRefreshTokenStore(redis as any);

    await store.revokeFamily('family-1', 123456);

    expect(redis.smembers).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.mgetCalls.map((batch) => batch.length)).toEqual([128, 128, 4]);
    expect(redis.transactions.map((tx) => tx.writes.length)).toEqual([128, 128, 4]);
    for (const tx of redis.transactions) {
      for (const write of tx.writes) {
        expect(JSON.parse(write.value)).toMatchObject({ revokedAtEpochSec: 123456 });
        expect(write.ttl).toBeGreaterThan(0);
      }
    }
  });

  it('streams multiple SSCAN pages and tolerates duplicate members idempotently', async () => {
    const records = new Map<string, string | null>([
      ['at:oauth:refresh:a', JSON.stringify(tokenRecord('a'))],
      ['at:oauth:refresh:b', JSON.stringify(tokenRecord('b'))],
      ['at:oauth:refresh:c', JSON.stringify(tokenRecord('c'))],
    ]);
    const redis = new FakeRedis([
      ['7', ['at:oauth:refresh:a', 'at:oauth:refresh:b']],
      ['0', ['at:oauth:refresh:b', 'at:oauth:refresh:c']],
    ], records);
    const store = new OAuthRefreshTokenStore(redis as any);

    await store.revokeFamily('family-1', 42);

    expect(redis.sscan).toHaveBeenCalledTimes(2);
    expect(redis.mgetCalls).toEqual([
      ['at:oauth:refresh:a', 'at:oauth:refresh:b'],
      ['at:oauth:refresh:b', 'at:oauth:refresh:c'],
    ]);
    const writtenKeys = redis.transactions.flatMap((tx) => tx.writes.map((write) => write.key));
    expect(writtenKeys).toEqual([
      'at:oauth:refresh:a',
      'at:oauth:refresh:b',
      'at:oauth:refresh:b',
      'at:oauth:refresh:c',
    ]);
  });

  it('skips missing or malformed token records without expanding the batch', async () => {
    const keys = [
      'at:oauth:refresh:valid',
      'at:oauth:refresh:missing',
      'at:oauth:refresh:malformed',
    ];
    const records = new Map<string, string | null>([
      [keys[0]!, JSON.stringify(tokenRecord('valid'))],
      [keys[1]!, null],
      [keys[2]!, '{not-json'],
    ]);
    const redis = new FakeRedis([['0', keys]], records);
    const store = new OAuthRefreshTokenStore(redis as any);

    await store.revokeFamily('family-1', 88);

    expect(redis.transactions).toHaveLength(1);
    expect(redis.transactions[0]?.writes).toHaveLength(1);
    expect(redis.transactions[0]?.writes[0]?.key).toBe('at:oauth:refresh:valid');
  });

  it('does no writes for an empty family', async () => {
    const redis = new FakeRedis([['0', []]], new Map());
    const store = new OAuthRefreshTokenStore(redis as any);

    await store.revokeFamily('family-1', 99);

    expect(redis.mget).not.toHaveBeenCalled();
    expect(redis.multi).not.toHaveBeenCalled();
  });
});
