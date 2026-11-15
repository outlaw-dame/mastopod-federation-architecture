import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerEntrywayFastifyRoutes } from "../fastify-routes.js";

describe("Entryway Fastify routes", () => {
  it("requires the Entryway bearer token for account creation", async () => {
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      service: {
        createAccount: vi.fn(),
      } as any,
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/entryway/accounts",
      payload: {
        username: "alice",
        password: "CorrectHorseBatteryStaple1",
        profile: { displayName: "Alice" },
      },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("passes sanitized signup payload and header idempotency key to the service", async () => {
    const app = Fastify();
    const createAccount = vi.fn().mockResolvedValue({
      replayed: false,
      route: {
        accountId: "acct_11111111-1111-4111-8111-111111111111",
        username: "alice",
        handle: "@alice@localhost",
        webId: "http://localhost:3000/alice/profile/card#me",
        actorId: "http://localhost:3000/alice",
        podStorageUrl: "http://localhost:3000/alice/data/",
        providerId: "default",
        providerBaseUrl: "http://localhost:3000",
        oidcIssuer: "http://localhost:3000",
        status: "active",
        provisioning: {
          phase: "ACTIVE",
          attempts: 1,
          checks: [],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      service: {
        createAccount,
      } as any,
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/entryway/accounts",
      headers: {
        authorization: "Bearer entryway-token",
        "idempotency-key": "idem.route.001",
      },
      payload: {
        username: "Alice",
        email: "Alice@example.com",
        password: "CorrectHorseBatteryStaple1",
        profile: { displayName: "Alice" },
        protocols: { atproto: { enabled: true, didMethod: "did:plc" } },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({
      username: "Alice",
      idempotencyKey: "idem.route.001",
    }));
    expect(response.json().account.provisioning).not.toHaveProperty("idempotencyKeyHash");
    expect(response.body).not.toContain("CorrectHorseBatteryStaple1");
    await app.close();
  });

  it("allows public username resolution only when explicitly enabled", async () => {
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      allowPublicResolve: true,
      service: {
        getByUsername: vi.fn().mockResolvedValue({
          accountId: "acct_11111111-1111-4111-8111-111111111111",
          username: "alice",
          handle: "@alice@localhost",
          webId: "http://localhost:3000/alice/profile/card#me",
          actorId: "http://localhost:3000/alice",
          podStorageUrl: "http://localhost:3000/alice/data/",
          providerId: "default",
          providerBaseUrl: "http://localhost:3000",
          oidcIssuer: "http://localhost:3000",
          status: "active",
          provisioning: { phase: "ACTIVE", attempts: 1, checks: [] },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as any,
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/entryway/accounts/by-username/alice",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().account.webId).toBe("http://localhost:3000/alice/profile/card#me");
    expect(response.json().account).toEqual({
      username: "alice",
      handle: "@alice@localhost",
      webId: "http://localhost:3000/alice/profile/card#me",
      actorId: "http://localhost:3000/alice",
    });
    expect(response.body).not.toContain("acct_");
    expect(response.body).not.toContain("provisioning");
    expect(response.body).not.toContain("podStorageUrl");
    await app.close();
  });

  it("hides failed and provisioning accounts from anonymous public username lookup", async () => {
    const route = {
      accountId: "acct_11111111-1111-4111-8111-111111111111",
      username: "alice",
      handle: "@alice@localhost",
      webId: "http://localhost:3000/alice/profile/card#me",
      actorId: "http://localhost:3000/alice",
      podStorageUrl: "http://localhost:3000/alice/data/",
      providerId: "default",
      providerBaseUrl: "http://localhost:3000",
      oidcIssuer: "http://localhost:3000",
      status: "provisioning",
      appBootstrap: {
        status: "failed",
        appClientId: "https://memory.example/app",
        accessGrantUris: ["http://localhost:3000/alice/data/private-grant"],
      },
      provisioning: { phase: "FAILED", attempts: 1, checks: [], lastErrorMessage: "private diagnostic" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const getByUsername = vi.fn(async () => route);
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      allowPublicResolve: true,
      service: { getByUsername } as any,
    });
    await app.ready();

    for (const status of ["provisioning", "failed", "suspended", "migrating"]) {
      route.status = status;
      const response = await app.inject({ method: "GET", url: "/entryway/accounts/by-username/alice" });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("private-grant");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    await app.close();
  });

  it("keeps complete account route metadata behind a bearer token even when public resolution is enabled", async () => {
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      allowPublicResolve: true,
      service: {
        getByUsername: vi.fn().mockResolvedValue({
          accountId: "acct_11111111-1111-4111-8111-111111111111",
          username: "alice",
          handle: "@alice@localhost",
          webId: "http://localhost:3000/alice/profile/card#me",
          actorId: "http://localhost:3000/alice",
          podStorageUrl: "http://localhost:3000/alice/data/",
          providerId: "default",
          providerBaseUrl: "http://localhost:3000",
          oidcIssuer: "http://localhost:3000",
          status: "active",
          appBootstrap: { status: "ready", appClientId: "https://memory.example/app", accessGrantUris: ["private-grant"] },
          provisioning: { phase: "ACTIVE", attempts: 1, checks: [] },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as any,
    });
    await app.ready();
    const anonymous = await app.inject({ method: "GET", url: "/entryway/accounts/by-username/alice" });
    const authorized = await app.inject({
      method: "GET", url: "/entryway/accounts/by-username/alice",
      headers: { authorization: "Bearer entryway-token" },
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body).not.toContain("private-grant");
    expect(anonymous.body).not.toContain("acct_");
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().account.appBootstrap.accessGrantUris).toEqual(["private-grant"]);
    await app.close();
  });
});
