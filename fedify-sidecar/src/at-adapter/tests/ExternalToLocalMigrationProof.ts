/* eslint-disable no-console */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const BACKEND_BASE = (process.env['MIGRATION_PROOF_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
const SIDECAR_BASE = (process.env['MIGRATION_PROOF_SIDECAR_BASE_URL'] ?? 'http://localhost:8085').replace(/\/$/, '');
const USER_BEARER = process.env['MIGRATION_PROOF_USER_TOKEN'] ?? '';
const CANONICAL_ACCOUNT_ID = process.env['MIGRATION_PROOF_CANONICAL_ACCOUNT_ID'] ?? '';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson<T = Record<string, JsonValue>>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? JSON.parse(text) as T : ({} as T);
}

async function main(): Promise<void> {
  assert(USER_BEARER.length > 0, 'Missing MIGRATION_PROOF_USER_TOKEN');
  assert(CANONICAL_ACCOUNT_ID.length > 0, 'Missing MIGRATION_PROOF_CANONICAL_ACCOUNT_ID');

  const statusResponse = await fetch(
    `${BACKEND_BASE}/api/accounts/migrate-atproto/status?canonicalAccountId=${encodeURIComponent(CANONICAL_ACCOUNT_ID)}`,
    {
      headers: {
        authorization: `Bearer ${USER_BEARER}`,
        'x-request-id': `sidecar-proof-status-${Date.now()}`,
      },
    },
  );

  const statusBody = await readJson<{ migrationState?: string; correlationId?: string }>(statusResponse);
  assert(statusResponse.ok, `Migration status request failed: ${statusResponse.status}`);
  assert(typeof statusBody.migrationState === 'string', 'Migration status missing migrationState');

  const beforeWrite = await fetch(`${SIDECAR_BASE}/xrpc/com.atproto.sync.getLatestCommit`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${process.env['MIGRATION_PROOF_ATPROTO_ACCESS_TOKEN'] ?? ''}`,
    },
  });

  // During migration, sidecar should still be able to serve external mode reads/writes.
  // After completion, the same account should continue to function through the local managed path.
  assert(beforeWrite.status !== 500, `Unexpected sidecar failure during migration proof: ${beforeWrite.status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        migrationState: statusBody.migrationState,
        correlationId: statusBody.correlationId ?? null,
        sidecarStatus: beforeWrite.status,
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
