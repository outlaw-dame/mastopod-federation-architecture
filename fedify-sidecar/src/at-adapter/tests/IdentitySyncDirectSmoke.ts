import { Redis } from 'ioredis';
import { HttpIdentityBindingSyncService } from '../identity/IdentityBindingSyncService.js';
import { buildInternalIdentityProjectionPathsByCanonicalAccountId } from '../identity/InternalIdentityApi.js';
import { RedisAtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry.js';
import { RedisIdentityBindingRepository } from '../../core-domain/identity/RedisIdentityBindingRepository.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function asJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  const backendBase = env('ACTIVITYPODS_URL', 'http://localhost:3000');
  const token = env('ACTIVITYPODS_TOKEN', 'test-atproto-signing-token-local');
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
  const canonicalAccountId = env(
    'IDENTITY_SYNC_CANONICAL_ACCOUNT_ID',
    'http://localhost:3000/atproto365133'
  );

  const redis = new Redis(redisUrl);
  const repo = new RedisIdentityBindingRepository(redis);
  const repoRegistry = new RedisAtprotoRepoRegistry(redis);
  const sync = new HttpIdentityBindingSyncService({
    backendBaseUrl: backendBase,
    bearerToken: token,
    identityBindingRepository: repo,
    repoRegistry,
  });

  try {
    // 1. Prove backend identity endpoint responds with expected auth.
    const endpoints = buildInternalIdentityProjectionPathsByCanonicalAccountId(canonicalAccountId).map(
      (path) => `${backendBase.replace(/\/$/, '')}${path}`
    );
    let backendStatus = 0;
    let backendBody: unknown = null;
    let matchedEndpoint: string | null = null;

    for (const endpoint of endpoints) {
      const backendRes = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      backendStatus = backendRes.status;
      backendBody = await asJson(backendRes);

      if (backendRes.status === 200) {
        matchedEndpoint = endpoint;
        break;
      }

      if (backendRes.status !== 404) {
        break;
      }
    }

    assert(
      matchedEndpoint,
      `backend endpoint failed: ${backendStatus} ${JSON.stringify(backendBody)}`
    );

    // 2. Sync by canonical account id.
    const synced = await sync.syncByCanonicalAccountId(canonicalAccountId);
    assert(synced === true, 'syncByCanonicalAccountId returned false');

    // 3. Verify local repository by canonical account id.
    const byCanonical = await repo.getByCanonicalAccountId(canonicalAccountId);
    assert(byCanonical, 'local repo missing canonicalAccountId entry');
    assert(byCanonical.canonicalAccountId === canonicalAccountId, 'canonicalAccountId mismatch');
    assert(typeof byCanonical.webId === 'string' && byCanonical.webId.length > 0, 'missing webId');
    assert(typeof byCanonical.atprotoDid === 'string' && byCanonical.atprotoDid.length > 0, 'missing atprotoDid');
    assert(
      typeof byCanonical.atprotoHandle === 'string' && byCanonical.atprotoHandle.length > 0,
      'missing atprotoHandle'
    );
    assert(
      typeof byCanonical.atSigningKeyRef === 'string' && byCanonical.atSigningKeyRef.length > 0,
      'missing atSigningKeyRef'
    );
    assert(
      typeof byCanonical.atRotationKeyRef === 'string' && byCanonical.atRotationKeyRef.length > 0,
      'missing atRotationKeyRef'
    );

    // 4. Verify local repository by DID.
    const byDid = await repo.getByAtprotoDid(byCanonical.atprotoDid);
    assert(byDid, 'local repo missing DID index');
    assert(byDid.canonicalAccountId === canonicalAccountId, 'DID index canonicalAccountId mismatch');

    // 5. Verify local repository by handle.
    const byHandle = await repo.getByAtprotoHandle(byCanonical.atprotoHandle);
    assert(byHandle, 'local repo missing handle index');
    assert(byHandle.canonicalAccountId === canonicalAccountId, 'handle index canonicalAccountId mismatch');

    const backendProjection = backendBody as {
      repo?: { initialized?: boolean; rootCid?: string | null; rev?: string | null };
    } | null;
    let warmedRepoState: unknown = null;

    if (backendProjection?.repo?.initialized) {
      warmedRepoState = await repoRegistry.getRepoState(byCanonical.atprotoDid);
      assert(warmedRepoState, 'local repo registry missing bootstrapped state');
    }

    const report = {
      ok: true,
      backendBase,
      matchedEndpoint,
      canonicalAccountId,
      synced,
      repoProjectionPresent: !!backendProjection?.repo?.initialized,
      warmedRepoState,
      binding: {
        canonicalAccountId: byCanonical.canonicalAccountId,
        webId: byCanonical.webId,
        atprotoDid: byCanonical.atprotoDid,
        atprotoHandle: byCanonical.atprotoHandle,
        status: byCanonical.status,
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
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
