import { Redis } from 'ioredis';

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

async function requestSessionWithRetry(
  sidecarBase: string,
  identifier: string,
  password: string,
  maxAttempts = 10,
  delayMs = 1000
): Promise<{ status: number; body: unknown; attempts: number }> {
  let last: { status: number; body: unknown } = { status: 0, body: {} };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await requestJson(`${sidecarBase}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });

    if (last.status === 200) return { ...last, attempts: attempt };
    if (last.status !== 404 || attempt === maxAttempts) return { ...last, attempts: attempt };

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return { ...last, attempts: maxAttempts };
}

async function waitForBackendIdentityReady(
  backendBase: string,
  canonicalAccountId: string,
  token: string,
  maxAttempts = 20,
  delayMs = 1000
): Promise<{ ready: boolean; attempts: number; status: number; authUnavailable?: boolean }> {
  let status = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await requestJson(
      `${backendBase}/api/internal/identity/by-canonical?canonicalAccountId=${encodeURIComponent(canonicalAccountId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    status = res.status;
    if (res.status === 200) return { ready: true, attempts: attempt, status };
    if (res.status === 401) return { ready: false, attempts: attempt, status, authUnavailable: true };

    if (attempt < maxAttempts) {
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
    // Ignore parse errors; primary keys are sufficient.
  }

  await redis.del(...keys);
}

async function readLocalIdentity(redis: Redis, canonicalAccountId: string) {
  const raw = await redis.get(`identity:binding:${canonicalAccountId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function main() {
  const backendBase = env('UNIFIED_BACKEND_BASE', 'http://localhost:3000');
  const sidecarBase = env('UNIFIED_SIDECAR_BASE', 'http://localhost:8085');
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
  const internalToken =
    process.env['INTERNAL_IDENTITY_BEARER_TOKEN'] ??
    process.env['ACTIVITYPODS_TOKEN'] ??
    'test-atproto-signing-token-local';

  const username = process.env['UNIFIED_TEST_USERNAME'] ?? `write-miss-${Date.now()}`;
  const password = process.env['UNIFIED_TEST_PASSWORD'] ?? 'Phase7LivePass123';
  const email = process.env['UNIFIED_TEST_EMAIL'] ?? `${username}@example.com`;

  const redis = new Redis(redisUrl);
  const report: Record<string, unknown> = {
    backendBase,
    sidecarBase,
    redisUrl,
    username,
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
          displayName: 'Identity Sync Write Miss Proof',
          summary: 'Write path should sync identity on local miss',
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
        `backend internal identity projection not ready for ${canonicalAccountId}; last status ${backendIdentityReady.status}`
      );
    }

    const createSession = await requestSessionWithRetry(sidecarBase, did, password);

    (report['steps'] as Json)['createSession'] = {
      status: createSession.status,
      body: createSession.body,
      attempts: createSession.attempts,
    };
    assert(createSession.status === 200, `createSession failed: ${createSession.status}`);

    const createSessionBody = createSession.body as Json;
    const accessJwt = createSessionBody['accessJwt'] as string | undefined;
    assert(accessJwt, 'missing accessJwt');

    await deleteLocalIdentity(redis, canonicalAccountId, did, handle);

    const localAfterDelete = await readLocalIdentity(redis, canonicalAccountId);
    (report['steps'] as Json)['localAfterDelete'] = {
      exists: !!localAfterDelete,
    };
    assert(!localAfterDelete, 'local identity binding still exists after forced delete');

    const createRecord = await requestJson(
      `${sidecarBase}/xrpc/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessJwt}`,
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: `Identity sync write miss proof ${Date.now()}`,
            createdAt: new Date().toISOString(),
          },
        }),
      }
    );

    (report['steps'] as Json)['createRecord'] = createRecord;
    assert(createRecord.status === 200, `createRecord failed: ${createRecord.status}`);

    const createRecordBody = createRecord.body as Json;
    const uri = createRecordBody['uri'] as string | undefined;
    const cid = createRecordBody['cid'] as string | undefined;
    assert(uri, 'missing createRecord uri');
    assert(cid, 'missing createRecord cid');

    const localAfterWrite = await readLocalIdentity(redis, canonicalAccountId);
    (report['steps'] as Json)['localAfterWrite'] = {
      exists: !!localAfterWrite,
      binding: localAfterWrite
        ? {
            canonicalAccountId: localAfterWrite.canonicalAccountId,
            webId: localAfterWrite.webId,
            atprotoDid: localAfterWrite.atprotoDid,
            atprotoHandle: localAfterWrite.atprotoHandle,
            status: localAfterWrite.status,
          }
        : null,
    };

    assert(localAfterWrite, 'local identity binding was not recreated after write');
    assert(
      localAfterWrite.atprotoDid === did,
      `recreated binding DID mismatch: expected ${did}, got ${String(localAfterWrite.atprotoDid)}`
    );

    report['summary'] = {
      ok: true,
      canonicalAccountId,
      did,
      handle,
      uri,
      cid,
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
