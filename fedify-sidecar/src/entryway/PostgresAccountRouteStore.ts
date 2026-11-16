import pg from "pg";
import type { Pool, PoolConfig } from "pg";
import { EntrywayError } from "./errors.js";
import type { AccountRoute, AccountRouteReservationInput, AccountRouteReservationResult, AccountRouteStore } from "./types.js";

/** One SQL statement per mutation: a lost acknowledgment is never retried here. */
export class PostgresAccountRouteStore implements AccountRouteStore {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ safe: boolean }>(`
      SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
        AND NOT pg_has_role(current_user, 'paper_entryway_owner', 'MEMBER')
        AND NOT has_schema_privilege(current_user, 'paper_entryway', 'CREATE')
        AND NOT has_table_privilege(current_user, 'paper_entryway.routes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_function_privilege(current_user, 'paper_entryway.reserve(jsonb)', 'EXECUTE')
        AND has_function_privilege(current_user, 'paper_entryway.cas(text,bigint,text,jsonb)', 'EXECUTE')
        AND has_function_privilege(current_user, 'paper_entryway.get_account(text)', 'EXECUTE')
        AND has_function_privilege(current_user, 'paper_entryway.get_username(text)', 'EXECUTE')
        AND has_function_privilege(current_user, 'paper_entryway.stale(timestamptz,integer)', 'EXECUTE') AS safe
      FROM pg_roles r WHERE r.rolname = current_user`);
    if (result.rows[0]?.safe !== true) throw new Error("Entryway requires restricted PostgreSQL runtime credentials");
  }

  public async reserve(input: AccountRouteReservationInput): Promise<AccountRouteReservationResult> {
    if (input.route.accountId !== input.accountId || input.route.username !== input.username ||
      input.route.provisioning.idempotencyKeyHash !== input.idempotencyKeyHash ||
      input.route.provisioning.requestFingerprint !== input.requestFingerprint) {
      throw new EntrywayError("entryway_reservation_invalid", "Inconsistent Entryway reservation");
    }
    const result = await this.pool.query<{ result: AccountRouteReservationResult }>(
      "SELECT paper_entryway.reserve($1::jsonb) AS result", [encode(input.route)]);
    if (!result.rows[0]?.result) throw new Error("Entryway reservation returned no result");
    return result.rows[0].result;
  }

  public async getByAccountId(accountId: string): Promise<AccountRoute | null> {
    const result = await this.pool.query<{ route: AccountRoute | null }>(
      "SELECT paper_entryway.get_account($1) AS route", [accountId]);
    return result.rows[0]?.route ?? null;
  }

  public async getByUsername(username: string): Promise<AccountRoute | null> {
    const result = await this.pool.query<{ route: AccountRoute | null }>(
      "SELECT paper_entryway.get_username($1) AS route", [username]);
    return result.rows[0]?.route ?? null;
  }

  public async compareAndSet(expected: AccountRoute, next: AccountRoute): Promise<boolean> {
    const result = await this.pool.query<{ changed: boolean }>(
      "SELECT paper_entryway.cas($1,$2::bigint,$3,$4::jsonb) AS changed",
      [expected.accountId, expected.revision ?? 0, expected.provisioning.fenceToken ?? "", encode(next)]);
    return result.rows[0]?.changed === true;
  }

  public async listStaleProvisioning(beforeIso: string, limit: number): Promise<AccountRoute[]> {
    if (!Number.isFinite(Date.parse(beforeIso))) return [];
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 50;
    const result = await this.pool.query<{ route: AccountRoute }>(
      "SELECT paper_entryway.stale($1::timestamptz,$2::integer) AS route", [beforeIso, bounded]);
    return result.rows.map(row => row.route);
  }
}

function encode(route: AccountRoute): string {
  const encoded = JSON.stringify(route);
  if (Buffer.byteLength(encoded) > 65536) throw new Error("Entryway route exceeds storage limit");
  return encoded;
}

export function entrywayPostgresOptions(env: NodeJS.ProcessEnv): PoolConfig {
  let url: URL;
  try { url = new URL(env["ENTRYWAY_DATABASE_URL"] ?? ""); }
  catch { throw new Error("ENABLE_ENTRYWAY requires ENTRYWAY_DATABASE_URL"); }
  // Connection-string ssl parameters can override node-postgres TLS options.
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
    url.pathname.length < 2 || url.search || url.hash) throw new Error("Invalid Entryway database configuration");
  const disposable = env["NODE_ENV"] === "test" && env["ENTRYWAY_POSTGRES_DISPOSABLE"] === "confirmed";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: disposable && loopback ? false : {
      rejectUnauthorized: true,
      ...(env["ENTRYWAY_DATABASE_CA"] ? { ca: env["ENTRYWAY_DATABASE_CA"] } : {}),
    },
    max: 8,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    lock_timeout: 2000,
    query_timeout: 7000,
    idle_in_transaction_session_timeout: 5000,
    application_name: "paper-entryway",
  };
}

export async function openEntrywayPostgres(env: NodeJS.ProcessEnv): Promise<{ pool: Pool; store: PostgresAccountRouteStore }> {
  const pool = new pg.Pool(entrywayPostgresOptions(env));
  // Idle socket failures must not terminate the process or leak connection details.
  // Requests still receive a failed database operation; no fallback is permitted.
  pool.on("error", () => console.error("Entryway PostgreSQL idle connection failed"));
  const store = new PostgresAccountRouteStore(pool);
  try { await store.assertReady(); }
  catch { await pool.end(); throw new Error("Entryway PostgreSQL readiness or credential check failed"); }
  return { pool, store };
}
