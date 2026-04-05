import { Redis } from 'ioredis';

type Json = Record<string, unknown>;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ACCOUNT_CREATE_TIMEOUT_MS = 420_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function truncateForError(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 400) return trimmed;
  return `${trimmed.slice(0, 397)}...`;
}

async function asJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: truncateForError(text) };
  }
}

async function requestJson(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return {
      status: res.status,
      body: await asJson(res),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Request failed for ${url}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteLocalIdentity(redis: Redis, canonicalAccountId: string, did: string, handle: string) {
  const bindingRaw = await redis.get(`identity:binding:${canonicalAccountId}`);
  const keys = [
    `identity:binding:${canonicalAccountId}`,
    `identity:idx:did:${did}`,
    `identity:idx:handle:${handle.toLowerCase()}`,
    `atproto:repo:${did}`,
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
    // Primary keys are enough if the cached binding is malformed.
  }

  await redis.del(...keys);
  await redis.srem('atproto:repos', did);
}

async function readLocalIdentity(redis: Redis, canonicalAccountId: string) {
  const raw = await redis.get(`identity:binding:${canonicalAccountId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function readLocalRepo(redis: Redis, did: string) {
  const raw = await redis.get(`atproto:repo:${did}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function waitForWarmup(
  redis: Redis,
  canonicalAccountId: string,
  did: string,
  timeoutMs: number
): Promise<{ binding: unknown | null; repoState: unknown | null; elapsedMs: number }> {
  const startedAt = Date.now();
  let delayMs = 250;

  while (Date.now() - startedAt < timeoutMs) {
    const [binding, repoState] = await Promise.all([
      readLocalIdentity(redis, canonicalAccountId),
      readLocalRepo(redis, did),
    ]);

    if (binding && repoState) {
      return {
        binding,
        repoState,
        elapsedMs: Date.now() - startedAt,
      };
    }

    await sleep(withJitter(delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }

  return {
    binding: await readLocalIdentity(redis, canonicalAccountId),
    repoState: await readLocalRepo(redis, did),
    elapsedMs: Date.now() - startedAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withJitter(delayMs: number): number {
  return delayMs + Math.round(delayMs * 0.2 * Math.random());
}

async function main() {
  const backendBase = env('UNIFIED_BACKEND_BASE', 'http://localhost:3000');
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
  const warmIntervalMs = Number.parseInt(process.env['IDENTITY_WARM_INTERVAL_MS'] ?? '5000', 10);
  const waitBudgetMs = warmIntervalMs + 8_000;
  const accountCreateTimeoutMs = Number.parseInt(
    process.env['UNIFIED_ACCOUNT_CREATE_TIMEOUT_MS'] ?? String(DEFAULT_ACCOUNT_CREATE_TIMEOUT_MS),
    10
  );

  const username = process.env['UNIFIED_TEST_USERNAME'] ?? `warmup-${Date.now()}`;
  const password = process.env['UNIFIED_TEST_PASSWORD'] ?? 'Phase7LivePass123';
  const email = process.env['UNIFIED_TEST_EMAIL'] ?? `${username}@example.com`;

  const redis = new Redis(redisUrl);
  const report: Record<string, unknown> = {
    backendBase,
    redisUrl,
    username,
    warmIntervalMs,
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
          summary: 'Background warming should restore local identity state',
        },
        solid: { enabled: true },
        activitypub: { enabled: true },
        atproto: { enabled: true, didMethod: 'plc' },
      }),
    }, accountCreateTimeoutMs);

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
    const repoInitialized = atproto?.['repoInitialized'] as boolean | undefined;

    assert(canonicalAccountId, 'missing canonicalAccountId');
    assert(did, 'missing atproto.did');
    assert(handle, 'missing atproto.handle');
    assert(repoInitialized === true, 'expected signup response to be AT-ready');

    await deleteLocalIdentity(redis, canonicalAccountId, did, handle);

    const localAfterDelete = {
      binding: await readLocalIdentity(redis, canonicalAccountId),
      repoState: await readLocalRepo(redis, did),
    };
    (report['steps'] as Json)['localAfterDelete'] = {
      bindingExists: !!localAfterDelete.binding,
      repoExists: !!localAfterDelete.repoState,
    };

    assert(!localAfterDelete.binding, 'local identity binding still exists after forced delete');
    assert(!localAfterDelete.repoState, 'local repo state still exists after forced delete');

    const warmed = await waitForWarmup(redis, canonicalAccountId, did, waitBudgetMs);

    (report['steps'] as Json)['warmupResult'] = {
      elapsedMs: warmed.elapsedMs,
      bindingExists: !!warmed.binding,
      repoExists: !!warmed.repoState,
      binding: warmed.binding,
      repoState: warmed.repoState,
    };

    assert(warmed.binding, 'local identity binding was not recreated by background warmup');
    assert(warmed.repoState, 'local repo bootstrap state was not recreated by background warmup');

    const binding = warmed.binding as Json;
    const repoState = warmed.repoState as Json;

    assert(
      binding['atprotoDid'] === did,
      `recreated binding DID mismatch: expected ${did}, got ${String(binding['atprotoDid'])}`
    );
    assert(
      repoState['did'] === did,
      `recreated repo DID mismatch: expected ${did}, got ${String(repoState['did'])}`
    );

    report['summary'] = {
      ok: true,
      canonicalAccountId,
      did,
      handle,
      elapsedMs: warmed.elapsedMs,
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
