type Json = any;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ACCOUNT_CREATE_TIMEOUT_MS = 420_000;

function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const input = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(input)) {
    if (k === 'accessJwt' || k === 'refreshJwt' || k === 'password') {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
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
  init?: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    return {
      status: res.status,
      body: await asJson(res)
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Request failed for ${url}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
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
      body: JSON.stringify({
        identifier,
        password
      })
    });

    if (last.status === 200) {
      return { ...last, attempts: attempt };
    }

    if (last.status !== 404 || attempt === maxAttempts) {
      return { ...last, attempts: attempt };
    }

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
      `${backendBase}/api/internal/identity/by-canonical-account-id?canonicalAccountId=${encodeURIComponent(canonicalAccountId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    status = res.status;
    if (res.status === 200) {
      return { ready: true, attempts: attempt, status };
    }

    if (res.status === 401) {
      return { ready: false, attempts: attempt, status, authUnavailable: true };
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { ready: false, attempts: maxAttempts, status };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ensureEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function resolveIdentifier(
  mode: 'canonical' | 'did' | 'handle',
  canonicalAccountId: string,
  did: string,
  handle: string
): string {
  if (mode === 'did') return did;
  if (mode === 'handle') return handle;
  return canonicalAccountId;
}

async function main() {
  const env = process.env as Record<string, string | undefined>;
  const backendBase = ensureEnv('UNIFIED_BACKEND_BASE', 'http://localhost:3000');
  const sidecarBase = ensureEnv('UNIFIED_SIDECAR_BASE', 'http://localhost:8085');
  const internalToken =
    env['INTERNAL_IDENTITY_BEARER_TOKEN'] ??
    env['ACTIVITYPODS_TOKEN'] ??
    'test-atproto-signing-token-local';
  const identifierMode = (env['UNIFIED_TEST_IDENTIFIER_MODE'] ?? 'canonical') as
    | 'canonical'
    | 'did'
    | 'handle';

  const username = env['UNIFIED_TEST_USERNAME'] ?? `unified-${Date.now()}`;
  const password = env['UNIFIED_TEST_PASSWORD'] ?? 'Phase7LivePass123';
  const email = env['UNIFIED_TEST_EMAIL'] ?? `${username}@example.com`;
  const displayName = env['UNIFIED_TEST_DISPLAY_NAME'] ?? 'Unified Proof User';
  const summary = env['UNIFIED_TEST_SUMMARY'] ?? 'Unified identity sync proof';

  const requestedHandle = env['UNIFIED_TEST_REQUESTED_HANDLE'];
  const didMethod = (env['UNIFIED_TEST_DID_METHOD'] ?? 'plc') as 'plc' | 'web';
  const accountCreateTimeoutMs = Number.parseInt(
    env['UNIFIED_ACCOUNT_CREATE_TIMEOUT_MS'] ?? String(DEFAULT_ACCOUNT_CREATE_TIMEOUT_MS),
    10
  );

  const report: any = {
    backendBase,
    sidecarBase,
    username,
    didMethod,
    identifierMode,
    steps: {}
  };

  const createAccountPayload = {
    username,
    email,
    password,
    profile: {
      displayName,
      summary
    },
    solid: { enabled: true },
    activitypub: { enabled: true },
    atproto: {
      enabled: true,
      didMethod,
      ...(requestedHandle ? { requestedHandle } : {})
    }
  };

  const createAccount = await requestJson(`${backendBase}/api/accounts/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createAccountPayload)
  }, accountCreateTimeoutMs);

  report.steps = {
    ...(report.steps as Json),
    createAccount
  };

  assert(
    createAccount.status === 200 || createAccount.status === 201,
    `createAccount failed: ${createAccount.status}`
  );

  const createAccountBody = createAccount.body as Json;
  const canonicalAccountId = createAccountBody.canonicalAccountId as string | undefined;
  const webId = createAccountBody.webId as string | undefined;
  const atproto = createAccountBody.atproto as Json | undefined;
  const did = atproto?.did as string | undefined;
  const handle = atproto?.handle as string | undefined;

  assert(canonicalAccountId, 'createAccount response missing canonicalAccountId');
  assert(webId, 'createAccount response missing webId');
  assert(did, 'createAccount response missing atproto.did');
  assert(handle, 'createAccount response missing atproto.handle');

  const backendIdentityReady = await waitForBackendIdentityReady(
    backendBase,
    canonicalAccountId,
    internalToken
  );
  (report.steps as Json).backendIdentityReady = backendIdentityReady;
  if (!backendIdentityReady.authUnavailable) {
    assert(
      backendIdentityReady.ready,
      `backend internal identity projection not ready for ${canonicalAccountId}; last status ${backendIdentityReady.status}`
    );
  }

  const identifier = resolveIdentifier(identifierMode, canonicalAccountId, did, handle);

  const createSession = await requestSessionWithRetry(sidecarBase, identifier, password);

  (report.steps as Json).createSession = {
    status: createSession.status,
    body: createSession.body,
    attempts: createSession.attempts
  };

  assert(
    createSession.status === 200,
    `createSession failed after unified account creation: ${createSession.status}`
  );

  const createSessionBody = createSession.body as Json;
  const accessJwt = createSessionBody.accessJwt as string | undefined;
  const sessionDid = createSessionBody.did as string | undefined;
  const sessionHandle = createSessionBody.handle as string | undefined;

  assert(accessJwt, 'createSession response missing accessJwt');
  assert(sessionDid === did, `createSession DID mismatch: expected ${did}, got ${sessionDid}`);
  assert(
    typeof sessionHandle === 'string' && sessionHandle.length > 0,
    'createSession response missing handle'
  );

  const postRecord = {
    $type: 'app.bsky.feed.post',
    text: `Unified identity sync proof post ${Date.now()}`,
    createdAt: new Date().toISOString()
  };

  const createRecord = await requestJson(
    `${sidecarBase}/xrpc/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessJwt}`
      },
      body: JSON.stringify({
        repo: did,
        collection: 'app.bsky.feed.post',
        record: postRecord
      })
    }
  );

  (report.steps as Json).createRecord = createRecord;

  assert(createRecord.status === 200, `createRecord failed: ${createRecord.status}`);

  const createRecordBody = createRecord.body as Json;
  const uri = createRecordBody.uri as string | undefined;
  const cid = createRecordBody.cid as string | undefined;

  assert(uri, 'createRecord response missing uri');
  assert(cid, 'createRecord response missing cid');

  const rkey = uri.split('/').pop();
  assert(rkey, 'Unable to extract rkey from createRecord uri');

  const getRecord = await requestJson(
    `${sidecarBase}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(
      did
    )}&collection=${encodeURIComponent('app.bsky.feed.post')}&rkey=${encodeURIComponent(rkey)}`
  );

  (report.steps as Json).getRecord = getRecord;

  assert(getRecord.status === 200, `getRecord failed: ${getRecord.status}`);

  const getRecordBody = getRecord.body as Json;
  assert(
    (getRecordBody.uri as string | undefined) === uri,
    `getRecord uri mismatch: expected ${uri}, got ${String(getRecordBody.uri)}`
  );

  const getLatestCommit = await requestJson(
    `${sidecarBase}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`
  );

  (report.steps as Json).getLatestCommit = getLatestCommit;

  assert(
    getLatestCommit.status === 200,
    `getLatestCommit failed: ${getLatestCommit.status}`
  );

  const latestCommitBody = getLatestCommit.body as Json;
  assert(
    typeof latestCommitBody.cid === 'string' && latestCommitBody.cid.length > 0,
    'getLatestCommit response missing cid'
  );
  assert(
    typeof latestCommitBody.rev === 'string' && latestCommitBody.rev.length > 0,
    'getLatestCommit response missing rev'
  );

  report.summary = {
    ok: true,
    identifier,
    identifierMode,
    canonicalAccountId,
    webId,
    did,
    handle,
    uri,
    cid
  };

  console.log(JSON.stringify(redact(report), null, 2));
}

main().catch(err => {
  const failure = {
    summary: {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  };
  console.error(JSON.stringify(failure, null, 2));
  process.exit(1);
});
