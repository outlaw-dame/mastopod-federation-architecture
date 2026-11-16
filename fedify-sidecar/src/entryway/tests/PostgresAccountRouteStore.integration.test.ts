import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAccountRouteStore } from "../PostgresAccountRouteStore.js";
import type { AccountRoute } from "../types.js";

const enabled = process.env["ENTRYWAY_POSTGRES_INTEGRATION"] === "1";
const restore = process.env["ENTRYWAY_POSTGRES_RESTORE"] === "1";
const restart = process.env["ENTRYWAY_POSTGRES_VERIFY_RESTART"] === "1";
const snapshot = process.env["ENTRYWAY_TEST_SNAPSHOT"] ?? "/tmp/entryway-route-snapshot.json";
const route = (username: string = randomUUID()): AccountRoute => ({
  accountId: `acct_${randomUUID()}`, username, handle: "", webId: "", actorId: "",
  podStorageUrl: "", providerId: "", providerBaseUrl: "", oidcIssuer: "", status: "provisioning",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  provisioning: { phase: "USERNAME_RESERVED", attempts: 0, idempotencyKeyHash: randomUUID().replaceAll("-", "").repeat(2),
    requestFingerprint: "a".repeat(64), checks: [] },
});
const reservation = (r: AccountRoute) => ({ accountId: r.accountId, username: r.username,
  idempotencyKeyHash: r.provisioning.idempotencyKeyHash, requestFingerprint: r.provisioning.requestFingerprint, route: r });
const next = (r: AccountRoute): AccountRoute => ({ ...r, revision: (r.revision ?? 0) + 1,
  provisioning: { ...r.provisioning, fenceToken: randomUUID() } });

describe.skipIf(!enabled || restore || restart)("PostgreSQL canonical route authority with restricted credentials", () => {
  const pool = new pg.Pool({ connectionString: process.env["ENTRYWAY_TEST_DATABASE_URL"], max: 8, connectionTimeoutMillis: 3000,
    statement_timeout: 5000, lock_timeout: 2000 });
  const store = new PostgresAccountRouteStore(pool);
  beforeAll(() => store.assertReady());
  afterAll(() => pool.end());

  it("has no direct table writes, reads, DDL, or helper-function execution", async () => {
    for (const sql of ["SELECT * FROM paper_entryway.routes", "DELETE FROM paper_entryway.routes",
      "TRUNCATE paper_entryway.routes", "UPDATE paper_entryway.routes SET revision = 999",
      "CREATE TABLE paper_entryway.forged (id int)", "SELECT paper_entryway.valid_route('{}')",
      "SET ROLE paper_entryway_owner"]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("serializes competing usernames and idempotency reservations without duplicates", async () => {
    const a = route();
    const results = await Promise.all(Array.from({ length: 16 }, () => store.reserve(reservation(a))));
    expect(results.filter(r => r.kind === "created")).toHaveLength(1);
    expect(results.filter(r => r.kind === "replayed")).toHaveLength(15);
    const other = route(a.username);
    expect((await store.reserve(reservation(other))).kind).toBe("username_taken");
    const conflicting = { ...a, provisioning: { ...a.provisioning, requestFingerprint: "b".repeat(64) } };
    expect((await store.reserve(reservation(conflicting))).kind).toBe("idempotency_conflict");
    expect(await store.getByUsername(a.username.toUpperCase())).toEqual(a);
  });
  it("allows one winning worker, preserves uncertainty and proof replay evidence", async () => {
    const a = route(); await store.reserve(reservation(a));
    const candidates = Array.from({ length: 16 }, () => next(a));
    const wins = await Promise.all(candidates.map(n => store.compareAndSet(a, n)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const claimed = candidates[wins.indexOf(true)]!;
    const marked = next(claimed);
    marked.provisioning.providerCreateMayHaveSideEffects = true;
    marked.provisioning.ownerSessionProofUses = [{ jtiHash: "c".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }];
    expect(await store.compareAndSet(claimed, marked)).toBe(true);
    const cleared = next(marked); delete cleared.provisioning.providerCreateMayHaveSideEffects;
    expect(await store.compareAndSet(marked, cleared)).toBe(false);
    const replay = next(marked); replay.provisioning.ownerSessionProofUses = [];
    expect(await store.compareAndSet(marked, replay)).toBe(false);
    expect(await store.compareAndSet(a, next(a))).toBe(false);
    const quarantined = { ...next(marked), status: "reconciliation_required" as const };
    expect(await store.compareAndSet(marked, quarantined)).toBe(true);
    expect(await store.compareAndSet(quarantined, next(quarantined))).toBe(false);
    expect((await store.listStaleProvisioning("2030-01-01T00:00:00Z", 500)).some(r => r.accountId === a.accountId)).toBe(false);
    writeFileSync(snapshot, JSON.stringify(quarantined), { mode: 0o600 });
  });
  it("does not persist unknown secret-bearing fields or cross-account identity edits", async () => {
    const a = route();
    await expect(pool.query("SELECT paper_entryway.reserve($1::jsonb)", [{ ...a, password: "must-not-persist" }])).rejects.toThrow();
    await store.reserve(reservation(a));
    expect(await store.compareAndSet(a, { ...next(a), accountId: `acct_${randomUUID()}` })).toBe(false);
    expect(await store.compareAndSet(a, { ...next(a), username: "someone-else" })).toBe(false);
    expect(await store.compareAndSet(a, { ...next(a), revision: 5 })).toBe(false);
  });
  it("survives a worker reconnect with reservations and fences intact", async () => {
    const a = route(); await store.reserve(reservation(a));
    const otherPool = new pg.Pool({ connectionString: process.env["ENTRYWAY_TEST_DATABASE_URL"], max: 1 });
    try {
      const worker = new PostgresAccountRouteStore(otherPool);
      expect((await worker.reserve(reservation(a))).kind).toBe("replayed");
      expect(await worker.getByAccountId(a.accountId)).toEqual(a);
    } finally { await otherPool.end(); }
  });
});

describe.skipIf(!enabled || !restart)("database restart durability", () => {
  it("retains the exact irreversible marker, revision, quarantine and replay ledger", async () => {
    const pool = new pg.Pool({ connectionString: process.env["ENTRYWAY_TEST_DATABASE_URL"] });
    try {
      const store = new PostgresAccountRouteStore(pool); await store.assertReady();
      const saved = JSON.parse(readFileSync(snapshot, "utf8")) as AccountRoute;
      expect(await store.getByAccountId(saved.accountId)).toEqual(saved);
      const initial = route(saved.username);
      initial.accountId = saved.accountId;
      initial.provisioning.idempotencyKeyHash = saved.provisioning.idempotencyKeyHash;
      expect((await store.reserve(reservation(initial))).kind).toBe("replayed");
    } finally { await pool.end(); }
  });
});

describe.skipIf(!enabled || !restore)("logical backup restore retains evidence but refuses writes", () => {
  it("restores the exact route and requires reconciliation before creation or CAS", async () => {
    const pool = new pg.Pool({ connectionString: process.env["ENTRYWAY_TEST_DATABASE_URL"] });
    try {
      const store = new PostgresAccountRouteStore(pool); await store.assertReady();
      const saved = JSON.parse(readFileSync(snapshot, "utf8")) as AccountRoute;
      expect(await store.getByAccountId(saved.accountId)).toEqual(saved);
      await expect(store.reserve(reservation(route()))).rejects.toMatchObject({ code: "55000" });
      await expect(store.compareAndSet(saved, next(saved))).rejects.toMatchObject({ code: "55000" });
    } finally { await pool.end(); }
  });
});
