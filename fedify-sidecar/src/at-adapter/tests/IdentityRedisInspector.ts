import { Redis } from 'ioredis';

type IdentitySnapshot = {
  keys: string[];
  binding?: unknown;
  indexes: Record<string, string | null>;
};

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const results: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    results.push(...keys);
  } while (cursor !== '0');

  return results.sort();
}

async function readKey(redis: Redis, key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

async function snapshotIdentity(
  redis: Redis,
  canonicalAccountId: string,
  did?: string,
  handle?: string
): Promise<IdentitySnapshot> {
  const bindingKey = `identity:binding:${canonicalAccountId}`;
  const keys = await scanKeys(redis, 'identity:*');

  const bindingRaw = await readKey(redis, bindingKey);
  const binding = bindingRaw ? JSON.parse(bindingRaw) : undefined;

  const indexes: Record<string, string | null> = {};

  if (did) {
    indexes[`identity:idx:did:${did}`] = await readKey(redis, `identity:idx:did:${did}`);
  }

  if (handle) {
    indexes[`identity:idx:handle:${handle.toLowerCase()}`] = await readKey(
      redis,
      `identity:idx:handle:${handle.toLowerCase()}`
    );
  }

  if (binding && typeof binding === 'object') {
    const b = binding as {
      activityPubActorUri?: string;
      webId?: string;
    };

    if (b.activityPubActorUri) {
      const key = `identity:idx:actor:${b.activityPubActorUri}`;
      indexes[key] = await readKey(redis, key);
    }

    if (b.webId) {
      const key = `identity:idx:webid:${b.webId}`;
      indexes[key] = await readKey(redis, key);
    }
  }

  return {
    keys,
    binding,
    indexes,
  };
}

function diffSnapshots(before: IdentitySnapshot, after: IdentitySnapshot) {
  const beforeKeys = new Set(before.keys);
  const afterKeys = new Set(after.keys);

  const added = [...afterKeys].filter(k => !beforeKeys.has(k));
  const removed = [...beforeKeys].filter(k => !afterKeys.has(k));

  const changedIndexes: Record<string, { before: string | null; after: string | null }> = {};

  const allIndexKeys = new Set([
    ...Object.keys(before.indexes),
    ...Object.keys(after.indexes),
  ]);

  for (const key of allIndexKeys) {
    const b = before.indexes[key] ?? null;
    const a = after.indexes[key] ?? null;

    if (b !== a) {
      changedIndexes[key] = { before: b, after: a };
    }
  }

  return {
    addedKeys: added,
    removedKeys: removed,
    changedIndexes,
  };
}

async function main() {
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
  const canonicalAccountId = env(
    'IDENTITY_SYNC_CANONICAL_ACCOUNT_ID',
    'http://localhost:3000/atproto365133'
  );

  const did = process.env['IDENTITY_SYNC_DID'];
  const handle = process.env['IDENTITY_SYNC_HANDLE'];

  const redis = new Redis(redisUrl);

  try {
    console.log('--- SNAPSHOT BEFORE ---');
    const before = await snapshotIdentity(redis, canonicalAccountId, did, handle);
    console.log(JSON.stringify(before, null, 2));

    if (process.env['INSPECT_WAIT'] === 'true') {
      console.log('\nWaiting for ENTER before taking AFTER snapshot...\n');
      await new Promise<void>(resolve => {
        process.stdin.once('data', () => resolve());
      });
    }

    console.log('--- SNAPSHOT AFTER ---');
    const after = await snapshotIdentity(redis, canonicalAccountId, did, handle);
    console.log(JSON.stringify(after, null, 2));

    console.log('--- DIFF ---');
    const diff = diffSnapshots(before, after);
    console.log(JSON.stringify(diff, null, 2));

    console.log(
      JSON.stringify(
        {
          ok: true,
          canonicalAccountId,
          inspectedDid: did,
          inspectedHandle: handle,
        },
        null,
        2
      )
    );
  } finally {
    redis.disconnect();
  }
}

main().catch(err => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
