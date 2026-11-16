import { describe, expect, it, vi } from "vitest";
import { entrywayPostgresOptions, PostgresAccountRouteStore } from "../PostgresAccountRouteStore.js";
import type { Pool } from "pg";

describe("Entryway PostgreSQL configuration", () => {
  it("requires explicit canonical credentials and rejects TLS overrides", () => {
    expect(() => entrywayPostgresOptions({ REDIS_URL: "redis://localhost" })).toThrow();
    expect(() => entrywayPostgresOptions({ ENTRYWAY_DATABASE_URL: "postgres://u:p@db/paper?sslmode=disable" })).toThrow();
    const options = entrywayPostgresOptions({ ENTRYWAY_DATABASE_URL: "postgres://u:p@db/paper" });
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.max).toBe(8);
    expect(options.statement_timeout).toBe(5000);
  });
  it("permits plaintext only for explicitly disposable loopback tests", () => {
    const env = { NODE_ENV: "test", ENTRYWAY_POSTGRES_DISPOSABLE: "confirmed", ENTRYWAY_DATABASE_URL: "postgres://u:p@127.0.0.1/paper" };
    expect(entrywayPostgresOptions(env).ssl).toBe(false);
    expect(entrywayPostgresOptions({ ...env, ENTRYWAY_DATABASE_URL: "postgres://u:p@remote/paper" }).ssl).not.toBe(false);
  });
  it("never retries a database read or silently falls back on failure", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection lost"));
    const store = new PostgresAccountRouteStore({ query } as unknown as Pool);
    await expect(store.getByAccountId("acct_test")).rejects.toThrow("connection lost");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
