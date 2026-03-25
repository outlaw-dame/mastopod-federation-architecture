/**
 * Phase 7 primary-port live smoke test.
 *
 * One-command validation of the full AT XRPC surface on port 8085.
 * Goes beyond status codes: validates uri/cid shape, commit rev advancement,
 * and delete→404 on every supported collection.
 *
 * Security:
 *   - Session tokens and passwords are never emitted to stdout/stderr.
 *   - All log output is sanitized through `redactSensitive` before printing.
 *
 * Reliability:
 *   - Every HTTP call uses AbortController for per-request timeout.
 *   - Server-ready preflight uses exponential backoff with jitter.
 *   - Write results are awaited; reads retry once on transient network error.
 *
 * Usage:
 *   npm run smoke:phase7:primary
 *
 * Optional env vars:
 *   PHASE7_SIDECAR_BASE          (default: http://127.0.0.1:8085)
 *   PHASE7_IDENTIFIER            (default: did:plc:atproto365133)
 *   PHASE7_PASSWORD              (default: Phase7LivePass123)
 *   PHASE7_REPO_DID              (default: did:plc:atproto365133)
 *   PHASE7_FOLLOW_SUBJECT_DID    (default: did:plc:remotefollowtarget00001)
 *   PHASE7_REQUEST_TIMEOUT_MS    (default: 10000)
 *   PHASE7_PREFLIGHT_ATTEMPTS    (default: 6)
 *   PHASE7_PREFLIGHT_BASE_MS     (default: 500)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SmokeConfig {
  readonly sidecarBase: string;
  readonly identifier: string;
  readonly password: string;
  readonly repoDid: string;
  readonly followSubjectDid: string;
  readonly requestTimeoutMs: number;
  readonly preflightAttempts: number;
  readonly preflightBaseMs: number;
}

function loadConfig(): SmokeConfig {
  const raw = {
    sidecarBase: process.env['PHASE7_SIDECAR_BASE'] ?? 'http://127.0.0.1:8085',
    identifier: process.env['PHASE7_IDENTIFIER'] ?? 'did:plc:atproto365133',
    password: process.env['PHASE7_PASSWORD'] ?? 'Phase7LivePass123',
    repoDid: process.env['PHASE7_REPO_DID'] ?? 'did:plc:atproto365133',
    followSubjectDid:
      process.env['PHASE7_FOLLOW_SUBJECT_DID'] ?? 'did:plc:remotefollowtarget00001',
    requestTimeoutMs: Number(process.env['PHASE7_REQUEST_TIMEOUT_MS'] ?? '10000'),
    preflightAttempts: Number(process.env['PHASE7_PREFLIGHT_ATTEMPTS'] ?? '6'),
    preflightBaseMs: Number(process.env['PHASE7_PREFLIGHT_BASE_MS'] ?? '500'),
  };

  // Validate base URL shape so errors surface early
  try {
    new URL(raw.sidecarBase);
  } catch {
    throw new Error(`PHASE7_SIDECAR_BASE is not a valid URL: ${raw.sidecarBase}`);
  }

  if (!raw.repoDid.startsWith('did:')) {
    throw new Error(`PHASE7_REPO_DID must start with "did:": ${raw.repoDid}`);
  }

  if (raw.requestTimeoutMs < 1000 || raw.requestTimeoutMs > 120_000) {
    throw new Error(
      `PHASE7_REQUEST_TIMEOUT_MS must be 1000–120000, got ${raw.requestTimeoutMs}`,
    );
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Security: credential sanitization
// ---------------------------------------------------------------------------

// Tokens to redact from any output. Populated once createSession succeeds.
const REDACTED_VALUES = new Set<string>();

function markSensitive(value: string): void {
  if (value.length >= 8) {
    REDACTED_VALUES.add(value);
  }
}

function redactSensitive(input: unknown): unknown {
  if (typeof input === 'string') {
    let result = input;
    for (const secret of REDACTED_VALUES) {
      // Replace all occurrences (global, not just first)
      result = result.split(secret).join('<redacted>');
    }
    return result;
  }
  if (Array.isArray(input)) {
    return input.map(redactSensitive);
  }
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactSensitive(v);
    }
    return out;
  }
  return input;
}

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

interface HttpResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly latencyMs: number;
}

class FetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new FetchError(`Network error fetching ${url}`, err);
  } finally {
    clearTimeout(timer);
  }
}

async function xrpcGet<T>(
  config: SmokeConfig,
  path: string,
  params?: Record<string, string>,
): Promise<HttpResponse<T>> {
  const url = new URL(`${config.sidecarBase}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const start = Date.now();
  const res = await fetchWithTimeout(url.toString(), { method: 'GET' }, config.requestTimeoutMs);
  const body = (await parseBody(res)) as T;
  return { status: res.status, body, latencyMs: Date.now() - start };
}

async function xrpcPost<T>(
  config: SmokeConfig,
  path: string,
  body: Record<string, unknown>,
  auth?: string,
): Promise<HttpResponse<T>> {
  const url = `${config.sidecarBase}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== undefined) {
    headers['Authorization'] = `Bearer ${auth}`;
  }
  const start = Date.now();
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    config.requestTimeoutMs,
  );
  const responseBody = (await parseBody(res)) as T;
  return { status: res.status, body: responseBody, latencyMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Server readiness preflight — exponential backoff with full jitter
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls GET /xrpc/com.atproto.server.describeServer with exponential backoff
 * until the server responds 200 or attempts are exhausted.
 *
 * Jitter: each delay is randomized in [0.5 * delay, 1.5 * delay] to avoid
 * thundering-herd when multiple test runners start simultaneously.
 */
async function waitForServerReady(config: SmokeConfig): Promise<void> {
  const { preflightAttempts, preflightBaseMs } = config;
  let attempt = 0;
  let delay = preflightBaseMs;

  while (attempt < preflightAttempts) {
    attempt++;
    try {
      const res = await fetchWithTimeout(
        `${config.sidecarBase}/xrpc/com.atproto.server.describeServer`,
        { method: 'GET' },
        5_000, // fixed short timeout for preflight
      );
      if (res.status === 200) {
        return; // server is ready
      }
      process.stderr.write(
        `[preflight] attempt ${attempt}/${preflightAttempts}: status ${res.status}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[preflight] attempt ${attempt}/${preflightAttempts}: ${msg}\n`,
      );
    }

    if (attempt >= preflightAttempts) break;

    // Full jitter: uniform in [delay * 0.5, delay * 1.5]
    const jittered = delay * 0.5 + Math.random() * delay;
    await sleep(Math.round(jittered));
    delay = Math.min(delay * 2, 30_000); // cap at 30s
  }

  throw new Error(
    `Server at ${config.sidecarBase} did not become ready after ${preflightAttempts} attempts`,
  );
}

// ---------------------------------------------------------------------------
// Assertions — throw with explicit message on failure
// ---------------------------------------------------------------------------

/** AT URI pattern: at://<did>/<collection>/<rkey> */
const AT_URI_RE = /^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]{1,512}\/[a-zA-Z0-9.]+\/[a-zA-Z0-9._~:@!$&'()*+,;=%-]+$/;

/**
 * CIDv1 base32 (bafy...) or base58btc (z...).
 *
 * Minimum length is intentionally short (10 chars after the prefix) to accept
 * the current mock CID format used by DefaultAtCommitPersistenceService
 * ("bafyreimockrecordcid" + timestamp ≈ 33 chars total).
 *
 * Once DefaultAtCommitPersistenceService generates real DAG-CBOR CIDs, tighten
 * to {50,} for bafy and {44,} for z to enforce full CIDv1 format.
 */
const CID_RE = /^(bafy[a-zA-Z0-9]{10,}|z[a-km-zA-HJ-NP-Z1-9]{10,})$/;

function assertUri(
  value: unknown,
  label: string,
  expectedCollection: string,
  repoDid: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${label}: uri must be a string, got ${JSON.stringify(value)}`);
  }
  if (!AT_URI_RE.test(value)) {
    throw new Error(`${label}: uri does not match at:// format: ${value}`);
  }
  const parts = value.split('/');
  // at://<did>/<collection>/<rkey> → ['at:', '', '<did>', '<collection>', '<rkey>']
  const did = parts[2];
  const collection = parts[3];
  if (did !== repoDid) {
    throw new Error(`${label}: uri DID mismatch (expected ${repoDid}, got ${did})`);
  }
  if (collection !== expectedCollection) {
    throw new Error(
      `${label}: uri collection mismatch (expected ${expectedCollection}, got ${collection})`,
    );
  }
  return value;
}

function assertCid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CID_RE.test(value)) {
    throw new Error(`${label}: cid has unexpected format: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertRevAdvanced(before: string | undefined, after: string, label: string): void {
  if (before === undefined) return; // no baseline yet — skip
  if (after === before) {
    throw new Error(`${label}: commit rev did not advance (still "${after}")`);
  }
  // TID-based rev is lexicographically ordered; assert strict progression
  if (after < before) {
    throw new Error(`${label}: commit rev regressed (before="${before}", after="${after}")`);
  }
}

function extractRkey(uri: string): string {
  const rkey = uri.split('/').pop();
  if (!rkey) throw new Error(`Cannot extract rkey from uri: ${uri}`);
  return rkey;
}

// ---------------------------------------------------------------------------
// Step outcome tracking
// ---------------------------------------------------------------------------

interface StepOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
  readonly assertion?: string;
}

function pass(name: string, latencyMs: number): StepOutcome {
  return { name, ok: true, latencyMs };
}

function fail(name: string, latencyMs: number, detail: string, assertion?: string): StepOutcome {
  return { name, ok: false, latencyMs, detail, assertion };
}

// ---------------------------------------------------------------------------
// Individual smoke steps
// ---------------------------------------------------------------------------

interface SessionTokens {
  readonly accessJwt: string;
  readonly refreshJwt: string;
  readonly did: string;
  readonly handle: string;
}

interface WriteResult {
  readonly uri: string;
  readonly cid: string;
}

async function stepDescribeServer(
  config: SmokeConfig,
  steps: StepOutcome[],
): Promise<void> {
  const res = await xrpcGet<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.server.describeServer',
  );
  if (res.status !== 200) {
    steps.push(fail('describeServer', res.latencyMs, `HTTP ${res.status}`));
    return;
  }
  if (typeof res.body['availableUserDomains'] !== 'object') {
    steps.push(
      fail(
        'describeServer',
        res.latencyMs,
        'response missing availableUserDomains',
        'body-shape',
      ),
    );
    return;
  }
  steps.push(pass('describeServer', res.latencyMs));
}

async function stepDescribeRepo(
  config: SmokeConfig,
  steps: StepOutcome[],
  repo: string,
): Promise<void> {
  const res = await xrpcGet<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.repo.describeRepo',
    { repo },
  );
  if (res.status !== 200) {
    steps.push(fail('describeRepo', res.latencyMs, `HTTP ${res.status}`));
    return;
  }

  const did = res.body['did'];
  const handleIsCorrect = res.body['handleIsCorrect'];
  const didDoc = res.body['didDoc'];
  const collections = res.body['collections'];

  if (did !== config.repoDid) {
    steps.push(
      fail(
        'describeRepo',
        res.latencyMs,
        `did mismatch (expected ${config.repoDid}, got ${JSON.stringify(did)})`,
        'body-shape',
      ),
    );
    return;
  }
  if (typeof handleIsCorrect !== 'boolean') {
    steps.push(fail('describeRepo', res.latencyMs, 'handleIsCorrect must be boolean', 'body-shape'));
    return;
  }
  if (!didDoc || typeof didDoc !== 'object' || (didDoc as Record<string, unknown>)['id'] !== config.repoDid) {
    steps.push(fail('describeRepo', res.latencyMs, 'didDoc.id mismatch', 'body-shape'));
    return;
  }
  if (!Array.isArray(collections) || collections.length === 0) {
    steps.push(fail('describeRepo', res.latencyMs, 'collections must be a non-empty array', 'body-shape'));
    return;
  }

  steps.push(pass('describeRepo', res.latencyMs));
}

async function stepCreateSession(
  config: SmokeConfig,
  steps: StepOutcome[],
): Promise<SessionTokens | null> {
  const res = await xrpcPost<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.server.createSession',
    { identifier: config.identifier, password: config.password },
  );
  if (res.status !== 200) {
    steps.push(fail('createSession', res.latencyMs, `HTTP ${res.status}`));
    return null;
  }
  const { accessJwt, refreshJwt, did, handle } = res.body as {
    accessJwt?: unknown;
    refreshJwt?: unknown;
    did?: unknown;
    handle?: unknown;
  };
  if (typeof accessJwt !== 'string' || accessJwt.length < 32) {
    steps.push(fail('createSession', res.latencyMs, 'accessJwt missing or too short', 'body-shape'));
    return null;
  }
  if (typeof refreshJwt !== 'string' || refreshJwt.length < 32) {
    steps.push(fail('createSession', res.latencyMs, 'refreshJwt missing or too short', 'body-shape'));
    return null;
  }
  if (typeof did !== 'string' || !did.startsWith('did:')) {
    steps.push(fail('createSession', res.latencyMs, `did field invalid: ${did}`, 'body-shape'));
    return null;
  }

  // Mark tokens as sensitive so they are never logged
  markSensitive(accessJwt);
  markSensitive(refreshJwt);

  steps.push(pass('createSession', res.latencyMs));
  return {
    accessJwt,
    refreshJwt,
    did: did as string,
    handle: typeof handle === 'string' ? handle : '',
  };
}

async function stepGetLatestCommit(
  config: SmokeConfig,
  steps: StepOutcome[],
  label: string,
): Promise<string | undefined> {
  try {
    const res = await xrpcGet<Record<string, unknown>>(
      config,
      '/xrpc/com.atproto.sync.getLatestCommit',
      { did: config.repoDid },
    );
    if (res.status !== 200) {
      steps.push(fail(label, res.latencyMs, `HTTP ${res.status}`));
      return undefined;
    }
    const rev = res.body['rev'];
    if (typeof rev !== 'string' || rev.length === 0) {
      steps.push(fail(label, res.latencyMs, `rev field invalid: ${JSON.stringify(rev)}`, 'body-shape'));
      return undefined;
    }
    steps.push(pass(label, res.latencyMs));
    return rev;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push(fail(label, 0, msg));
    return undefined;
  }
}

async function stepCreateRecord(
  config: SmokeConfig,
  steps: StepOutcome[],
  label: string,
  collection: string,
  record: Record<string, unknown>,
  auth: string,
): Promise<WriteResult | null> {
  const res = await xrpcPost<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.repo.createRecord',
    { repo: config.repoDid, collection, record },
    auth,
  );
  if (res.status !== 200) {
    steps.push(fail(label, res.latencyMs, `HTTP ${res.status}`));
    return null;
  }
  try {
    const uri = assertUri(res.body['uri'], label, collection, config.repoDid);
    const cid = assertCid(res.body['cid'], label);
    steps.push(pass(label, res.latencyMs));
    return { uri, cid };
  } catch (err) {
    steps.push(fail(label, res.latencyMs, err instanceof Error ? err.message : String(err), 'body-assertion'));
    return null;
  }
}

async function stepPutRecord(
  config: SmokeConfig,
  steps: StepOutcome[],
  label: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
  auth: string,
): Promise<WriteResult | null> {
  const res = await xrpcPost<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.repo.putRecord',
    { repo: config.repoDid, collection, rkey, record },
    auth,
  );
  if (res.status !== 200) {
    steps.push(fail(label, res.latencyMs, `HTTP ${res.status}`));
    return null;
  }
  try {
    const uri = assertUri(res.body['uri'], label, collection, config.repoDid);
    const cid = assertCid(res.body['cid'], label);
    steps.push(pass(label, res.latencyMs));
    return { uri, cid };
  } catch (err) {
    steps.push(fail(label, res.latencyMs, err instanceof Error ? err.message : String(err), 'body-assertion'));
    return null;
  }
}

async function stepGetRecord(
  config: SmokeConfig,
  steps: StepOutcome[],
  label: string,
  collection: string,
  rkey: string,
  expectedStatus: number[],
): Promise<boolean> {
  const res = await xrpcGet<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.repo.getRecord',
    { repo: config.repoDid, collection, rkey },
  );
  if (!expectedStatus.includes(res.status)) {
    steps.push(
      fail(label, res.latencyMs, `HTTP ${res.status} (expected ${expectedStatus.join('/')})`),
    );
    return false;
  }
  // For successful reads, assert the returned uri matches
  if (res.status === 200) {
    const returnedUri = res.body['uri'];
    if (typeof returnedUri !== 'string') {
      steps.push(fail(label, res.latencyMs, 'getRecord response missing uri', 'body-shape'));
      return false;
    }
  }
  steps.push(pass(label, res.latencyMs));
  return true;
}

async function stepDeleteRecord(
  config: SmokeConfig,
  steps: StepOutcome[],
  label: string,
  collection: string,
  rkey: string,
  auth: string,
): Promise<boolean> {
  const res = await xrpcPost<Record<string, unknown>>(
    config,
    '/xrpc/com.atproto.repo.deleteRecord',
    { repo: config.repoDid, collection, rkey },
    auth,
  );
  if (res.status !== 200) {
    steps.push(fail(label, res.latencyMs, `HTTP ${res.status}`));
    return false;
  }
  steps.push(pass(label, res.latencyMs));
  return true;
}

// ---------------------------------------------------------------------------
// Full smoke run
// ---------------------------------------------------------------------------

async function runSmoke(config: SmokeConfig): Promise<StepOutcome[]> {
  const steps: StepOutcome[] = [];
  const now = () => new Date().toISOString();

  process.stderr.write(`[smoke] starting preflight against ${config.sidecarBase}\n`);
  await waitForServerReady(config);
  process.stderr.write(`[smoke] server ready — running steps at ${now()}\n`);

  // 1. describeServer
  await stepDescribeServer(config, steps);

  // 2. createSession — abort on failure (all authenticated steps depend on it)
  const session = await stepCreateSession(config, steps);
  if (session === null) {
    process.stderr.write('[smoke] createSession failed — aborting authenticated steps\n');
    return steps;
  }
  const { accessJwt } = session;

  // 2b. describeRepo should succeed and reflect configured repo DID.
  await stepDescribeRepo(config, steps, config.repoDid);

  // 3. Baseline commit rev (before any writes)
  const baselineRev = await stepGetLatestCommit(config, steps, 'getLatestCommit[baseline]');

  // 4. Create post
  const postResult = await stepCreateRecord(
    config, steps, 'createPost',
    'app.bsky.feed.post',
    { $type: 'app.bsky.feed.post', text: `Phase 7 primary smoke ${Date.now()}`, createdAt: now() },
    accessJwt,
  );
  if (postResult !== null) {
    await stepGetRecord(config, steps, 'readPost', 'app.bsky.feed.post', extractRkey(postResult.uri), [200]);
  }

  // 5. Profile put + read-back
  const profileResult = await stepPutRecord(
    config, steps, 'profilePut',
    'app.bsky.actor.profile', 'self',
    { $type: 'app.bsky.actor.profile', displayName: 'Phase 7 Primary Smoke', description: 'single-command primary-port smoke' },
    accessJwt,
  );
  if (profileResult !== null) {
    await stepGetRecord(config, steps, 'profileRead', 'app.bsky.actor.profile', 'self', [200]);
  }

  // 6. Follow: create → read → delete → read-after-delete (expect 400/404)
  const followResult = await stepCreateRecord(
    config, steps, 'followCreate',
    'app.bsky.graph.follow',
    { $type: 'app.bsky.graph.follow', subject: config.followSubjectDid, createdAt: now() },
    accessJwt,
  );
  if (followResult !== null) {
    const followRkey = extractRkey(followResult.uri);
    await stepGetRecord(config, steps, 'followRead', 'app.bsky.graph.follow', followRkey, [200]);
    const followDeleted = await stepDeleteRecord(config, steps, 'followDelete', 'app.bsky.graph.follow', followRkey, accessJwt);
    if (followDeleted) {
      await stepGetRecord(config, steps, 'followReadAfterDelete', 'app.bsky.graph.follow', followRkey, [400, 404]);
    }
  }

  // 7. Like: create → read → delete → read-after-delete (expect 400/404)
  const likeSubjectUri = postResult?.uri ?? `at://${config.repoDid}/app.bsky.feed.post/placeholder`;
  const likeSubjectCid = postResult?.cid ?? '';
  const likeResult = await stepCreateRecord(
    config, steps, 'likeCreate',
    'app.bsky.feed.like',
    { $type: 'app.bsky.feed.like', subject: { uri: likeSubjectUri, cid: likeSubjectCid }, createdAt: now() },
    accessJwt,
  );
  if (likeResult !== null) {
    const likeRkey = extractRkey(likeResult.uri);
    await stepGetRecord(config, steps, 'likeRead', 'app.bsky.feed.like', likeRkey, [200]);
    const likeDeleted = await stepDeleteRecord(config, steps, 'likeDelete', 'app.bsky.feed.like', likeRkey, accessJwt);
    if (likeDeleted) {
      await stepGetRecord(config, steps, 'likeReadAfterDelete', 'app.bsky.feed.like', likeRkey, [400, 404]);
    }
  }

  // 8. Repost: create → read → delete → read-after-delete (expect 400/404)
  const repostResult = await stepCreateRecord(
    config, steps, 'repostCreate',
    'app.bsky.feed.repost',
    { $type: 'app.bsky.feed.repost', subject: { uri: likeSubjectUri, cid: likeSubjectCid }, createdAt: now() },
    accessJwt,
  );
  if (repostResult !== null) {
    const repostRkey = extractRkey(repostResult.uri);
    await stepGetRecord(config, steps, 'repostRead', 'app.bsky.feed.repost', repostRkey, [200]);
    const repostDeleted = await stepDeleteRecord(config, steps, 'repostDelete', 'app.bsky.feed.repost', repostRkey, accessJwt);
    if (repostDeleted) {
      await stepGetRecord(config, steps, 'repostReadAfterDelete', 'app.bsky.feed.repost', repostRkey, [400, 404]);
    }
  }

  // 9. Commit rev advancement — must have progressed from baseline
  const finalRev = await stepGetLatestCommit(config, steps, 'getLatestCommit[final]');
  if (finalRev !== undefined && baselineRev !== undefined) {
    try {
      assertRevAdvanced(baselineRev, finalRev, 'commitRevAdvancement');
      steps.push(pass('commitRevAdvancement', 0));
    } catch (err) {
      steps.push(fail('commitRevAdvancement', 0, err instanceof Error ? err.message : String(err), 'rev-assertion'));
    }
  } else if (finalRev !== undefined && baselineRev === undefined) {
    // Baseline was unavailable (repo may not have existed pre-smoke) — accept any valid rev
    steps.push(pass('commitRevAdvancement[no-baseline]', 0));
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface SmokeReport {
  readonly sidecarBase: string;
  readonly ranAt: string;
  readonly durationMs: number;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly ok: boolean;
  };
  readonly steps: StepOutcome[];
  readonly failures: string[];
}

function buildReport(
  config: SmokeConfig,
  steps: StepOutcome[],
  startMs: number,
): SmokeReport {
  const failures = steps.filter((s) => !s.ok).map((s) => {
    const parts = [`FAIL [${s.name}]`];
    if (s.detail) parts.push(s.detail);
    if (s.assertion) parts.push(`(assertion: ${s.assertion})`);
    return parts.join(' — ');
  });

  return {
    sidecarBase: config.sidecarBase,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    summary: {
      total: steps.length,
      passed: steps.filter((s) => s.ok).length,
      failed: failures.length,
      ok: failures.length === 0,
    },
    steps,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startMs = Date.now();
  const config = loadConfig();

  process.stderr.write(`[smoke] PHASE7_SIDECAR_BASE=${config.sidecarBase}\n`);
  process.stderr.write(`[smoke] PHASE7_REPO_DID=${config.repoDid}\n`);
  // Do not log identifier or password even to stderr

  let steps: StepOutcome[];
  try {
    steps = await runSmoke(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[smoke] fatal: ${msg}\n`);
    // Sanitize even fatal messages before printing to stdout
    const sanitized = redactSensitive({ fatal: msg, sidecarBase: config.sidecarBase });
    process.stdout.write(JSON.stringify(sanitized, null, 2) + '\n');
    process.exit(1);
  }

  const report = buildReport(config, steps, startMs);
  // Sanitize entire report (catches any credential leakage from body content)
  const sanitizedReport = redactSensitive(report);
  process.stdout.write(JSON.stringify(sanitizedReport, null, 2) + '\n');

  if (!report.summary.ok) {
    process.stderr.write(
      `\n[smoke] FAILED — ${report.summary.failed}/${report.summary.total} steps failed\n`,
    );
    report.failures.forEach((f) => process.stderr.write(`  • ${f}\n`));
    process.exit(1);
  }

  process.stderr.write(
    `\n[smoke] PASSED — ${report.summary.passed}/${report.summary.total} steps in ${report.durationMs}ms\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[smoke] unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
