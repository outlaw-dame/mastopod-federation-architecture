/*
 * Live Phase 7 proof runner.
 *
 * Executes:
 *   provision -> createSession -> createRecord -> getRecord -> getLatestCommit
 *
 * Expected env vars:
 *   PHASE7_BACKEND_BASE (default: http://localhost:3004)
 *   PHASE7_SIDECAR_BASE (default: http://localhost:8084)
 *   PHASE7_BEARER_TOKEN (default: test-atproto-signing-token-local)
 *   PHASE7_IDENTIFIER (default: did:plc:atproto365133)
 *   PHASE7_CANONICAL_ACCOUNT_ID (default: http://localhost:3000/atproto365133)
 *   PHASE7_PASSWORD (default: Phase7LivePass123)
 */

const backendBase = process.env['PHASE7_BACKEND_BASE'] ?? 'http://localhost:3004';
const sidecarBase = process.env['PHASE7_SIDECAR_BASE'] ?? 'http://localhost:8084';
const bearerToken = process.env['PHASE7_BEARER_TOKEN'] ?? 'test-atproto-signing-token-local';
const identifier = process.env['PHASE7_IDENTIFIER'] ?? 'did:plc:atproto365133';
const canonicalAccountId =
  process.env['PHASE7_CANONICAL_ACCOUNT_ID'] ?? 'http://localhost:3000/atproto365133';
const password = process.env['PHASE7_PASSWORD'] ?? 'Phase7LivePass123';

async function asJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main(): Promise<void> {
  const provisionRes = await fetch(`${backendBase}/api/internal/atproto/provision`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ canonicalAccountId }),
  });
  const provisionBody = await asJson(provisionRes);

  const sessionRes = await fetch(`${sidecarBase}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const sessionBody = await asJson(sessionRes);

  if (!sessionRes.ok) {
    console.log(
      JSON.stringify(
        {
          provision: { status: provisionRes.status, body: provisionBody },
          createSession: { status: sessionRes.status, body: sessionBody },
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const did = sessionBody.did as string;
  const accessJwt = sessionBody.accessJwt as string;

  const createRes = await fetch(`${sidecarBase}/xrpc/com.atproto.repo.createRecord`, {
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
        text: `Phase7 live proof ${Date.now()}`,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  const createBody = await asJson(createRes);

  if (!createRes.ok) {
    console.log(
      JSON.stringify(
        {
          provision: { status: provisionRes.status, body: provisionBody },
          createSession: { status: sessionRes.status, body: sessionBody },
          createRecord: { status: createRes.status, body: createBody },
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const uri = createBody.uri as string;
  const rkey = uri.split('/').pop();

  const getRecordRes = await fetch(
    `${sidecarBase}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent('app.bsky.feed.post')}&rkey=${encodeURIComponent(rkey ?? '')}`,
  );
  const getRecordBody = await asJson(getRecordRes);

  const latestRes = await fetch(
    `${sidecarBase}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`,
  );
  const latestBody = await asJson(latestRes);

  console.log(
    JSON.stringify(
      {
        provision: { status: provisionRes.status, body: provisionBody },
        createSession: { status: sessionRes.status, body: sessionBody },
        createRecord: { status: createRes.status, body: createBody },
        getRecord: { status: getRecordRes.status, body: getRecordBody },
        getLatestCommit: { status: latestRes.status, body: latestBody },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('[PHASE7 LIVE PROOF FAILED]', error);
  process.exit(1);
});
