import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RedisExternalAtSessionStore,
  type StoredExternalAtSession,
} from './ExternalAtSessionStore.js';

const INSECURE_REPOSITORY_PLACEHOLDER =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALID_TEST_KEY =
  '9f5f0bb1633b8d2d4c832a533bf807f22a275d259de198819e165b498abe8473';

afterEach(() => {
  vi.unstubAllEnvs();
});

function createRedis() {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    del: vi.fn(async (key: string) => Number(values.delete(key))),
  };
}

function session(): StoredExternalAtSession {
  return {
    canonicalAccountId: 'https://pod.example/alice/profile/card#me',
    did: 'did:plc:alice',
    handle: 'alice.example',
    pdsUrl: 'https://pds.example',
    accessJwt: 'sensitive-access-token',
    refreshJwt: 'sensitive-refresh-token',
    createdAt: '2026-08-15T00:00:00.000Z',
    dpopPrivateKeyJwk: JSON.stringify({ kty: 'EC', d: 'private-key-material' }),
  };
}

describe('RedisExternalAtSessionStore encryption key boundary', () => {
  it('fails closed on the repository-known fallback key outside fixture mode', () => {
    vi.stubEnv('AT_LOCAL_FIXTURE', 'false');
    vi.stubEnv('NODE_ENV', 'development');

    expect(() => new RedisExternalAtSessionStore(
      createRedis(),
      INSECURE_REPOSITORY_PLACEHOLDER,
    )).toThrow(/placeholder key is forbidden/u);
  });

  it('fails closed on the repository-known fallback key in production even if fixture mode is set', () => {
    vi.stubEnv('AT_LOCAL_FIXTURE', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => new RedisExternalAtSessionStore(
      createRedis(),
      INSECURE_REPOSITORY_PLACEHOLDER,
    )).toThrow(/placeholder key is forbidden/u);
  });

  it('replaces the historical fallback with one process-ephemeral key only in non-production fixture mode', async () => {
    vi.stubEnv('AT_LOCAL_FIXTURE', 'true');
    vi.stubEnv('NODE_ENV', 'development');

    const redis = createRedis();
    const first = new RedisExternalAtSessionStore(redis, INSECURE_REPOSITORY_PLACEHOLDER, 3600);
    const second = new RedisExternalAtSessionStore(redis, INSECURE_REPOSITORY_PLACEHOLDER, 3600);
    const value = session();

    await first.put('fixture-session', value);
    await expect(first.get('fixture-session')).resolves.toEqual(value);
    await expect(second.get('fixture-session')).resolves.toEqual(value);

    const raw = redis.values.get('at:external:session:fixture-session');
    expect(raw).toBeDefined();
    expect(raw).not.toContain(value.accessJwt);
    expect(raw).not.toContain(value.refreshJwt!);
  });

  it('fails closed on an obvious repeated-byte placeholder', () => {
    expect(() => new RedisExternalAtSessionStore(
      createRedis(),
      '00'.repeat(32),
    )).toThrow(/cryptographically random key material/u);
  });

  it('still accepts a valid 256-bit key and round-trips encrypted session material', async () => {
    const redis = createRedis();
    const store = new RedisExternalAtSessionStore(redis, VALID_TEST_KEY, 3600);
    const value = session();

    await store.put('account-session', value);

    const raw = redis.values.get('at:external:session:account-session');
    expect(raw).toBeDefined();
    expect(raw).not.toContain(value.accessJwt);
    expect(raw).not.toContain(value.refreshJwt!);
    expect(raw).not.toContain('private-key-material');
    await expect(store.get('account-session')).resolves.toEqual(value);
  });

  it('deletes tampered ciphertext instead of returning untrusted session data', async () => {
    const redis = createRedis();
    const store = new RedisExternalAtSessionStore(redis, VALID_TEST_KEY, 3600);
    await store.put('account-session', session());

    const key = 'at:external:session:account-session';
    const envelope = JSON.parse(redis.values.get(key)!) as { ciphertext: string };
    const originalLastCharacter = envelope.ciphertext.at(-1);
    expect(originalLastCharacter).toBeDefined();
    const replacement = originalLastCharacter === 'A' ? 'B' : 'A';
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${replacement}`;
    redis.values.set(key, JSON.stringify(envelope));

    await expect(store.get('account-session')).resolves.toBeNull();
    expect(redis.del).toHaveBeenCalledWith(key);
    expect(redis.values.has(key)).toBe(false);
  });
});
