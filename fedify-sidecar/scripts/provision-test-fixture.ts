/**
 * Phase 7 test fixture provisioner.
 *
 * Seeds Redis with the minimal state required for the Phase 7 primary smoke
 * test (npm run smoke:phase7:primary) to pass fully against a live sidecar
 * running with AT_LOCAL_FIXTURE=true.
 *
 * What this script writes to Redis:
 *   identity:binding:{canonicalAccountId}       — IdentityBinding JSON
 *   identity:idx:did:{did}                      — DID → canonicalAccountId
 *   identity:idx:handle:{handle}                — handle → canonicalAccountId
 *   identity:all                                — Set of all canonicalAccountIds
 *   atproto:repo:{did}                          — RepositoryState JSON (genesis)
 *   atproto:repos                               — Set of all DIDs
 *   fixture:signing:key:{canonicalAccountId}:commit   — secp256k1 key material
 *   fixture:signing:key:{canonicalAccountId}:rotation — secp256k1 key material
 *
 * Idempotent: running twice with the same config is safe.
 * Pass --force to overwrite existing fixture state (re-generates keys).
 *
 * Usage:
 *   npm run provision:test:fixture
 *   npm run provision:test:fixture -- --force
 *
 * Optional env vars:
 *   REDIS_URL                     (default: redis://localhost:6379)
 *   PHASE7_CANONICAL_ACCOUNT_ID   (default: http://localhost:3000/atproto365133)
 *   PHASE7_DID                    (default: did:plc:atproto365133)
 *   PHASE7_HANDLE                 (default: atproto365133.test)
 *   PHASE7_CONTEXT_ID             (default: localhost)
 *   PHASE7_PASSWORD               (default: Phase7LivePass123)  — printed in summary only
 *
 * After running, start the sidecar with:
 *   AT_LOCAL_FIXTURE=true npm run dev
 *
 * Then run the smoke test:
 *   npm run smoke:phase7:primary
 */

import { generateKeyPairSync } from 'node:crypto';
import Redis from 'ioredis';
import { secp256k1PemToMultibase } from '../src/signing/LocalAtSigningService.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REDIS_URL           = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CANONICAL_ACCOUNT_ID = process.env['PHASE7_CANONICAL_ACCOUNT_ID'] ?? 'http://localhost:3000/atproto365133';
const DID                 = process.env['PHASE7_DID'] ?? 'did:plc:atproto365133';
const HANDLE              = process.env['PHASE7_HANDLE'] ?? 'atproto365133.test';
const CONTEXT_ID          = process.env['PHASE7_CONTEXT_ID'] ?? 'localhost';
const PASSWORD            = process.env['PHASE7_PASSWORD'] ?? 'Phase7LivePass123';
const FORCE               = process.argv.includes('--force');

// Redis key constants (must match RedisIdentityBindingRepository + RedisAtprotoRepoRegistry)
const BINDING_PREFIX     = 'identity:binding:';
const IDX_DID            = 'identity:idx:did:';
const IDX_HANDLE         = 'identity:idx:handle:';
const ALL_SET            = 'identity:all';
const REPO_PREFIX        = 'atproto:repo:';
const REPO_INDEX         = 'atproto:repos';
const FIXTURE_KEY_PREFIX = 'fixture:signing:key:';
const REPO_TTL_SECONDS   = 86400 * 30; // 30 days

// Genesis CID — a placeholder non-null CID so getLatestCommit works before any write.
// Must match CIDv1 base32 shape (bafy prefix + ≥10 alphanumeric chars).
const GENESIS_ROOT_CID   = 'bafyreigenesisplaceholder0000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Key generation helpers
// ---------------------------------------------------------------------------

interface KeyMaterial {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyMultibase: string;
}

function generateSecp256k1KeyPair(): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyMultibase = secp256k1PemToMultibase(publicKey as unknown as string);
  return {
    privateKeyPem:      privateKey as unknown as string,
    publicKeyPem:       publicKey  as unknown as string,
    publicKeyMultibase,
  };
}

// ---------------------------------------------------------------------------
// Provision helpers
// ---------------------------------------------------------------------------

async function checkExists(redis: Redis, key: string): Promise<boolean> {
  return (await redis.exists(key)) > 0;
}

async function provisionSigningKeys(
  redis: Redis,
  canonicalAccountId: string,
  force: boolean,
): Promise<{ commitKey: KeyMaterial; rotationKey: KeyMaterial }> {
  const commitRedisKey   = `${FIXTURE_KEY_PREFIX}${canonicalAccountId}:commit`;
  const rotationRedisKey = `${FIXTURE_KEY_PREFIX}${canonicalAccountId}:rotation`;

  const commitExists   = await checkExists(redis, commitRedisKey);
  const rotationExists = await checkExists(redis, rotationRedisKey);

  let commitKey: KeyMaterial;
  let rotationKey: KeyMaterial;

  if (!commitExists || force) {
    commitKey = generateSecp256k1KeyPair();
    await redis.set(commitRedisKey, JSON.stringify(commitKey));
    process.stderr.write(`[provision] ${force && commitExists ? 'Replaced' : 'Created'} commit signing key\n`);
  } else {
    const raw = await redis.get(commitRedisKey);
    commitKey = JSON.parse(raw!) as KeyMaterial;
    process.stderr.write('[provision] Commit signing key already exists — skipping (use --force to regenerate)\n');
  }

  if (!rotationExists || force) {
    // Rotation key must be distinct from commit key — generate independently
    rotationKey = generateSecp256k1KeyPair();
    await redis.set(rotationRedisKey, JSON.stringify(rotationKey));
    process.stderr.write(`[provision] ${force && rotationExists ? 'Replaced' : 'Created'} rotation signing key\n`);
  } else {
    const raw = await redis.get(rotationRedisKey);
    rotationKey = JSON.parse(raw!) as KeyMaterial;
    process.stderr.write('[provision] Rotation signing key already exists — skipping (use --force to regenerate)\n');
  }

  // Safety: keys must be distinct
  if (commitKey.publicKeyMultibase === rotationKey.publicKeyMultibase) {
    throw new Error('Commit and rotation keys are identical — provisioning rejected');
  }

  return { commitKey, rotationKey };
}

async function provisionIdentityBinding(
  redis: Redis,
  canonicalAccountId: string,
  did: string,
  handle: string,
  contextId: string,
  commitKey: KeyMaterial,
  rotationKey: KeyMaterial,
  force: boolean,
): Promise<void> {
  const bindingKey = `${BINDING_PREFIX}${canonicalAccountId}`;
  const exists = await checkExists(redis, bindingKey);

  if (exists && !force) {
    process.stderr.write('[provision] Identity binding already exists — skipping (use --force to overwrite)\n');
    return;
  }

  // Remove stale secondary indexes if overwriting
  if (exists && force) {
    const old = JSON.parse((await redis.get(bindingKey))!);
    if (old.atprotoDid) await redis.del(`${IDX_DID}${old.atprotoDid}`);
    if (old.atprotoHandle) await redis.del(`${IDX_HANDLE}${(old.atprotoHandle as string).toLowerCase()}`);
  }

  const now = new Date().toISOString();
  const binding = {
    canonicalAccountId,
    contextId,
    webId:              canonicalAccountId, // V6.5: canonicalAccountId === webId
    activityPubActorUri: canonicalAccountId,
    atprotoDid:          did,
    atprotoHandle:       handle,
    canonicalDidMethod:  'did:plc',
    atprotoPdsEndpoint:  null,
    apSigningKeyRef:     `${canonicalAccountId}#ap-signing-key`,
    atSigningKeyRef:     `${FIXTURE_KEY_PREFIX}${canonicalAccountId}:commit`,
    atRotationKeyRef:    `${FIXTURE_KEY_PREFIX}${canonicalAccountId}:rotation`,
    plc: {
      opCid:            null,
      rotationKeyRef:   `${FIXTURE_KEY_PREFIX}${canonicalAccountId}:rotation`,
      plcUpdateState:   null,
      lastSubmittedAt:  null,
      lastConfirmedAt:  null,
      lastError:        null,
    },
    didWeb: null,
    accountLinks: {
      apAlsoKnownAs:  [`at://${did}`],
      atAlsoKnownAs:  [canonicalAccountId],
      relMe:          [],
      webIdSameAs:    [],
      webIdAccounts:  [],
    },
    status:    'active',
    createdAt: now,
    updatedAt: now,
    // Fixture-only metadata
    _fixtureNote: 'Created by provision-test-fixture.ts — not for production use',
    _commitKeyMultibase:   commitKey.publicKeyMultibase,
    _rotationKeyMultibase: rotationKey.publicKeyMultibase,
  };

  await redis.set(bindingKey, JSON.stringify(binding));
  await redis.set(`${IDX_DID}${did}`, canonicalAccountId);
  await redis.set(`${IDX_HANDLE}${handle.toLowerCase()}`, canonicalAccountId);
  await redis.sadd(ALL_SET, canonicalAccountId);

  process.stderr.write(`[provision] Identity binding ${exists ? 'replaced' : 'created'} for ${canonicalAccountId}\n`);
}

async function provisionRepoState(
  redis: Redis,
  did: string,
  force: boolean,
): Promise<void> {
  const repoKey = `${REPO_PREFIX}${did}`;
  const exists = await checkExists(redis, repoKey);

  if (exists && !force) {
    process.stderr.write('[provision] Repository state already exists — skipping (use --force to overwrite)\n');
    return;
  }

  const now = new Date().toISOString();
  const repoState = {
    did,
    rootCid:      GENESIS_ROOT_CID, // Non-null so getLatestCommit works before first write
    rev:          '0',
    commits:      [],
    collections:  [],
    totalRecords: 0,
    sizeBytes:    0,
    lastCommitAt: now,
    snapshotAt:   now,
    // Extra fields used by the projection worker's simplified shape
    status:    'active',
    createdAt: now,
    updatedAt: now,
  };

  await redis.set(repoKey, JSON.stringify(repoState), 'EX', REPO_TTL_SECONDS);
  await redis.sadd(REPO_INDEX, did);

  process.stderr.write(`[provision] Repository state ${exists ? 'replaced' : 'created'} for ${did}\n`);
}

// ---------------------------------------------------------------------------
// Summary output
// ---------------------------------------------------------------------------

function printSummary(
  commitKey: KeyMaterial,
  rotationKey: KeyMaterial,
): void {
  const credentialsJson = JSON.stringify({ [CANONICAL_ACCOUNT_ID]: PASSWORD });
  const summary = {
    status:             'ok',
    canonicalAccountId: CANONICAL_ACCOUNT_ID,
    did:                DID,
    handle:             HANDLE,
    commitKeyMultibase:  commitKey.publicKeyMultibase,
    rotationKeyMultibase: rotationKey.publicKeyMultibase,
    sidecarStartCommand: [
      `AT_LOCAL_FIXTURE=true`,
      `AT_LOCAL_FIXTURE_CREDS='${credentialsJson}'`,
      `npm run dev`,
    ].join(' \\\n  '),
    smokeTestCommand: [
      `PHASE7_SIDECAR_BASE=http://127.0.0.1:8085`,
      `PHASE7_IDENTIFIER=${DID}`,
      `PHASE7_PASSWORD=${PASSWORD}`,
      `PHASE7_REPO_DID=${DID}`,
      `npm run smoke:phase7:primary`,
    ].join(' \\\n  '),
    note: 'Keys are stored unencrypted in Redis. For testing only.',
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stderr.write(`[provision] Connecting to Redis: ${REDIS_URL.replace(/:[^@]*@/, ':***@')}\n`);

  const redis = new Redis(REDIS_URL, {
    lazyConnect:       true,
    enableReadyCheck:  true,
    connectTimeout:    5_000,
    commandTimeout:    5_000,
    maxRetriesPerRequest: 1,
  });

  redis.on('error', (err: Error) => {
    process.stderr.write(`[provision] Redis error: ${err.message}\n`);
  });

  try {
    await redis.connect();
    process.stderr.write('[provision] Redis connected\n');

    if (FORCE) {
      process.stderr.write('[provision] --force mode: existing fixture state will be overwritten\n');
    }

    const { commitKey, rotationKey } = await provisionSigningKeys(redis, CANONICAL_ACCOUNT_ID, FORCE);

    await provisionIdentityBinding(
      redis,
      CANONICAL_ACCOUNT_ID,
      DID,
      HANDLE,
      CONTEXT_ID,
      commitKey,
      rotationKey,
      FORCE,
    );

    await provisionRepoState(redis, DID, FORCE);

    process.stderr.write('[provision] Fixture provisioning complete\n');
    printSummary(commitKey, rotationKey);

  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}

main().catch((err) => {
  process.stderr.write(`[provision] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
