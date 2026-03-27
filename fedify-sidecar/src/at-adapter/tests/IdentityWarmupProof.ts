import { Redis } from 'ioredis';
import { buildInternalIdentityProjectionPathsByCanonicalAccountId } from '../identity/InternalIdentityApi.js';

type Json = Record<string, unknown>;

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

async function requestJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  return {
    status: res.status,
    body: await asJson(res),
  };
}

async function waitForBackendIdentityReady(
  backendBase: string,
  canonicalAccountId: string,
  token: string,
  maxAttempts = 20,
  delayMs = 1000
): Promise<{ ready: boolean; attempts: number; status: number; authUnavailable?: boolean }> {
  let status = 0;
  const paths = buildInternalIdentityProjectionPathsByCanonicalAccountId(canonicalAccountId);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sawNotFound = false;

    for (const path of paths) {
      const res = await requestJson(`${backendBase.replace(/\/$/, '')}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      status = res.status;
      if (res.status === 200) return { ready: true, attempts: attempt, status };
      if (res.status === 401) return { ready: false, attempts: attempt, status, authUnavailable: true };
      if (res.status === 404) {
        sawNotFound = true;
        continue;
      }

      break;
    }

    if (sawNotFound && attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { ready: false, attempts: maxAttempts, status };
}

async function deleteLocalIdentity(redis: Redis, canonicalAccountId: string, did: string, handle: string) {
  const bindingRaw = await redis.get(`identity:binding:${canonicalAccountId}`);
  const keys = [
    `identity:binding:${canonicalAccountId}`,
    `identity:idx:did:${did}`,
    `identity:idx:handle:${handle.toLowerCase()}`,
  ];

  try {
    if (bindingRaw) {
      const binding = JSON.parse(bindingRaw) as { activityPubActorUri?: string | null; webId?: string | null };
      if (binding.activityPubActorUri) {
        keys.push(`identity:idx:actor:${binding.activityPubActorUri}`);
      }
      if (binding.webId) {
        keys.push(`identity:idx:webid:${binding.webId}`);
      }
    }
  } catch {
    // Primary identity keys are enough for the proof if the binding is malformed.
  }

  await redis.del(...keys);
}

async function readLocalIdentity(redis: Redis, canonicalAccountId: string) {
  const raw = await redis.get(`identity:binding:${canonicalAccountId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function waitForLocalIdentity(
  redis: Redis,
  canonicalAccountId: string,
  timeoutMs: number,
  pollMs = 500
) {
  const startedAt = Date.now();
  let binding = await readLocalIdentity(redis, canonicalAccountId);

  while (!binding && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    binding = await readLocalIdentity(redis, canonicalAccountId);
  }

  return {
    binding,
    waitedMs: Date.now() - startedAt,
  };
}

async function main() {
  const backendBase = env('UNIFIED_BACKEND_BASE', 'http://localhost:3000');
  const sidecarBase = env('UNIFIED_SIDECAR_BASE', 'http://localhost:8085');
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
  const internalToken =
    process.env['INTERNAL_IDENTITY_BEARER_TOKEN'] ??
    process.env['ACTIVITYPODS_TOKEN'] ??
    'test-atproto-signing-token-local';
  const warmIntervalMs = Number.parseInt(process.env['IDENTITY_WARM_INTERVAL_MS'] ?? '5000', 10);
  const waitBudgetMs = warmIntervalMs + 3000;

  const username = process.env['UNIFIED_TEST_USERNAME'] ?? `warmup-${Date.now()}`;
  const password = process.env['UNIFIED_TEST_PASSWORD'] ?? 'Phase7LivePass123';
  const email = process.env['UNIFIED_TEST_EMAIL'] ?? `${username}@example.com`;

  const redis = new Redis(redisUrl);
  const report: Record<string, unknown> = {
    backendBase,
    sidecarBase,
    redisUrl,
    username,
    warmIntervalMs,
    waitBudgetMs,
    steps: {},
  };

  try {
    const createAccount = await requestJson(`${backendBase}/api/accounts/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        email,
        password,
        profile: {
          displayName: 'Identity Warmup Proof',
          summary: 'Background warmup should recreate local identity state',
        },
        solid: { enabled: true },
        activitypub: { enabled: true },
        atproto: { enabled: true, didMethod: 'plc' },
      }),
    });

    (report['steps'] as Json)['createAccount'] = createAccount;
    assert(
      createAccount.status === 200 || createAccount.status === 201,
      `createAccount failed: ${createAccount.status}`
    );

    const createAccountBody = createAccount.body as Json;
    const canonicalAccountId = createAccountBody['canonicalAccountId'] as string | undefined;
    const atproto = createAccountBody['atproto'] as Json | undefined;
    const did = atproto?.['did'] as string | undefined;
    const handle = atproto?.['handle'] as string | undefined;

    assert(canonicalAccountId, 'missing canonicalAccountId');
    assert(did, 'missing atproto.did');
    assert(handle, 'missing atproto.handle');

    const backendIdentityReady = await waitForBackendIdentityReady(
      backendBase,
      canonicalAccountId,
      internalToken
    );
    (report['steps'] as Json)['backendIdentityReady'] = backendIdentityReady;
    if (!backendIdentityReady.authUnavailable) {
      assert(
        backendIdentityReady.ready,
        `backend identity projection not ready for ${canonicalAccountId}; last status ${backendIdentityReady.status}`
      );
    }

    await deleteLocalIdentity(redis, canonicalAccountId, did, handle);

    const localAfterDelete = await readLocalIdentity(redis, canonicalAccountId);
    (report['steps'] as Json)['localAfterDelete'] = {
      exists: !!localAfterDelete,
    };
    assert(!localAfterDelete, 'local identity binding still exists after forced delete');

    const localAfterWarmup = await waitForLocalIdentity(
      redis,
      canonicalAccountId,
      waitBudgetMs
    );
    (report['steps'] as Json)['localAfterWarmup'] = {
      exists: !!localAfterWarmup.binding,
      waitedMs: localAfterWarmup.waitedMs,
      binding: localAfterWarmup.binding
        ? {
            canonicalAccountId: localAfterWarmup.binding.canonicalAccountId,
            webId: localAfterWarmup.binding.webId,
            atprotoDid: localAfterWarmup.binding.atprotoDid,
            atprotoHandle: localAfterWarmup.binding.atprotoHandle,
            status: localAfterWarmup.binding.status,
          }
        : null,
    };

    assert(localAfterWarmup.binding, 'local identity binding was not recreated by warmup');
    assert(
      localAfterWarmup.binding.atprotoDid === did,
      `recreated binding DID mismatch: expected ${did}, got ${String(localAfterWarmup.binding.atprotoDid)}`
    );

    report['summary'] = {
      ok: true,
      canonicalAccountId,
      did,
      handle,
      waitedMs: localAfterWarmup.waitedMs,
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
        summary: {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      },
      null,
      2
    )
  );
  process.exit(1);
});
