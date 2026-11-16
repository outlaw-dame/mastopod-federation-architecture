import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PostgresAccountRouteStore, entrywayPostgresOptions } from './src/entryway/PostgresAccountRouteStore.js';

const password = readFileSync('/run/runtime-password', 'utf8').trim();
const ca = readFileSync('/run/ca.crt', 'utf8');
const options = entrywayPostgresOptions({ NODE_ENV: 'production',
  ENTRYWAY_DATABASE_URL: `postgres://entryway_runtime:${encodeURIComponent(password)}@postgres/entryway_control_plane`,
  ENTRYWAY_DATABASE_CA: ca });
const pool = new pg.Pool(options);
pool.on('error', () => { process.exitCode = 1; });
try {
  await new PostgresAccountRouteStore(pool).assertReady();
  const tls = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.equal(tls.rows[0]?.ssl, true);
  await assert.rejects(pool.query('SELECT * FROM paper_entryway.routes'), { code: '42501' });
  await assert.rejects(pool.query('SET ROLE paper_entryway_owner'), { code: '42501' });
  const plaintext = new pg.Pool({ ...options, ssl: false });
  try { await assert.rejects(plaintext.query('SELECT 1'), { code: '28000' }); }
  finally { await plaintext.end(); }
  console.log('PASS: verified TLS, restricted runtime role, direct reads and owner escalation denied, plaintext rejected. Release CLOSED.');
} catch {
  console.error('FAIL: staging database acceptance; inspect locally without publishing credentials.');
  process.exitCode = 1;
} finally { await pool.end(); }
