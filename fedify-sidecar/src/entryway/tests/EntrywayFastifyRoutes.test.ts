import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerEntrywayFastifyRoutes } from "../fastify-routes.js";
import { EntrywayError } from "../errors.js";

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

  it("offers only a sanitized provider-pinned native SAI URL on consent-required status", async () => {
    const expected = "https://id.pods.example.org/authorize?client_id=https%3A%2F%2Fmemory.example.org%2Fsai%2Fapp%23main";
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      service: {
        createAccount: vi.fn().mockRejectedValue(new EntrywayError(
          "app_consent_required", "Pod owner authorization is required",
          {
            statusCode: 428, retryable: false,
            details: {
              authorizationUrl: expected,
              password: "must-not-appear",
              accessJwt: "must-not-appear",
            },
          },
        )),
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
        username: "alice",
        password: "CorrectHorseBatteryStaple1",
        profile: { displayName: "Alice" },
      },
    });
    expect(response.statusCode).toBe(428);
    expect(response.json()).toEqual({
      error: "app_consent_required",
      message: "Pod owner authorization is required",
      retryable: false,
      authorizationUrl: expected,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("must-not-appear");
    expect(response.body).not.toContain("CorrectHorseBatteryStaple1");
    expect(response.json()).not.toHaveProperty("sessionHandoff");
    expect(response.body).not.toContain("do-not-relay");
    await app.close();
  });

  it.each([
    "javascript:alert(1)",
    "http://id.pods.example.org/authorize?client_id=https%3A%2F%2Fmemory.example%2Fapp",
    "https://user:password@id.pods.example.org/authorize?client_id=https%3A%2F%2Fmemory.example%2Fapp",
    "https://id.pods.example.org/authorize?next=https%3A%2F%2Fevil.example&client_id=https%3A%2F%2Fmemory.example%2Fapp",
    "https://id.pods.example.org/authorize?client_id=https%3A%2F%2Fmemory.example%2Fapp&client_id=https%3A%2F%2Fevil.example%2Fapp",
    "https://id.pods.example.org/authorize?client_id=javascript%3Aalert%281%29",
  ])("never relays unsafe SAI navigation URL %s", async unsafe => {
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      service: {
        createAccount: vi.fn().mockRejectedValue(new EntrywayError(
          "app_consent_required", "Pod owner authorization is required",
          { statusCode: 428, retryable: false, details: { authorizationUrl: unsafe } },
        )),
      } as any,
    });
    await app.ready();
    const result = await app.inject({
      method: "POST", url: "/entryway/accounts",
      headers: {
        authorization: "Bearer entryway-token",
        "idempotency-key": "idem.route.001",
      },
      payload: {
        username: "alice",
        password: "CorrectHorseBatteryStaple1",
        profile: { displayName: "Alice" },
      },
    });
    expect(result.statusCode).toBe(428);
    expect(result.json()).not.toHaveProperty("authorizationUrl");
    expect(result.body).not.toContain(unsafe);
    await app.close();
  });

  it("resumes native owner consent only under backend bearer and original idempotency header", async () => {
    const route = {
      accountId: "acct_11111111-1111-4111-8111-111111111111",
      username: "alice", handle: "@alice@localhost",
      webId: "http://localhost:3000/alice/profile/card#me",
      actorId: "http://localhost:3000/alice",
      podStorageUrl: "http://localhost:3000/alice/data/",
      providerId: "default", providerBaseUrl: "http://localhost:3000",
      oidcIssuer: "http://localhost:3000", status: "active",
      appBootstrap: {
        status: "ready", appClientId: "https://memory.example/app",
        accessGrantUris: ["http://localhost:3000/alice/data/grant"],
      },
      provisioning: {
        phase: "ACTIVE", attempts: 2, checks: [],
        idempotencyKeyHash: "private-hmac-only",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const resumeAwaitingConsent = vi.fn().mockResolvedValue({
      route, replayed: true, sessionHandoff: {
        type: "redirect", url: "https://never-return-session.example/token",
      },
    });
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      service: { resumeAwaitingConsent } as any,
    });
    await app.ready();
    const request = {
      method: "POST" as const,
      url: "/entryway/accounts/consent/resume",
      payload: {
        username: "Alice",
        appClientId: "https://memory.example/app",
        ownerSessionProof: "signed-owner-session-proof-" + "x".repeat(96),
      },
    };
    const unauthorized = await app.inject(request);
    expect(unauthorized.statusCode).toBe(401);
    const noKey = await app.inject({
      ...request, headers: { authorization: "Bearer entryway-token" },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error).toBe("idempotency_key_required");
    const extraPassword = await app.inject({
      ...request,
      headers: {
        authorization: "Bearer entryway-token",
        "idempotency-key": "idem.alice.0001.0123456789abcdef",
      },
      payload: {
        ...request.payload,
        password: "CorrectHorseBatteryStaple1",
      },
    });
    expect(extraPassword.statusCode).toBe(400);
    expect(resumeAwaitingConsent).not.toHaveBeenCalled();

    const success = await app.inject({
      ...request,
      headers: {
        authorization: "Bearer entryway-token",
        "idempotency-key": "idem.alice.0001.0123456789abcdef",
      },
    });
    expect(success.statusCode).toBe(200);
    expect(resumeAwaitingConsent).toHaveBeenCalledWith({
      username: "Alice",
      appClientId: "https://memory.example/app",
      idempotencyKey: "idem.alice.0001.0123456789abcdef",
      ownerSessionProof: "signed-owner-session-proof-" + "x".repeat(96),
    });
    expect(success.json().account.status).toBe("active");
    expect(success.json().replayed).toBe(true);
    expect(success.json()).not.toHaveProperty("sessionHandoff");
    expect(success.body).not.toContain("never-return-session");
    expect(success.body).not.toContain("private-hmac-only");
    expect(success.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("does not expose a browser resume route or accept client-supplied redirect state", async () => {
    const resumeAwaitingConsent = vi.fn().mockRejectedValue(new EntrywayError(
      "app_consent_required", "Pod owner authorization is required", {
        statusCode: 428,
        retryable: false,
        details: {
          authorizationUrl: "https://id.pods.example/authorize?client_id=https%3A%2F%2Fmemory.example%2Fapp",
        },
      },
    ));
    const app = Fastify();
    registerEntrywayFastifyRoutes(app, {
      entrywayToken: "entryway-token",
      service: { resumeAwaitingConsent } as any,
    });
    await app.ready();
    const rejected = await app.inject({
      method: "POST", url: "/entryway/accounts/consent/resume",
      headers: {
        authorization: "Bearer entryway-token",
        "idempotency-key": "idem.alice.0001.0123456789abcdef",
      },
      payload: {
        username: "alice",
        appClientId: "https://memory.example/app",
        ownerSessionProof: "signed-owner-session-proof-" + "x".repeat(96),
        redirectUri: "https://evil.example/callback",
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(resumeAwaitingConsent).not.toHaveBeenCalled();
    const pending = await app.inject({
      method: "POST", url: "/entryway/accounts/consent/resume",
      headers: {
        authorization: "Bearer entryway-token",
        "idempotency-key": "idem.alice.0001.0123456789abcdef",
      },
      payload: {
        username: "alice",
        appClientId: "https://memory.example/app",
        ownerSessionProof: "signed-owner-session-proof-" + "x".repeat(96),
      },
    });
    expect(pending.statusCode).toBe(428);
    expect(pending.json().authorizationUrl).toContain("id.pods.example/authorize");
    expect(pending.body).not.toContain("evil.example");
    await app.close();
  });

  it("passes sanitized signup payload and header idempotency key to the service", async () => {
    const app = Fastify();
    const createAccount = vi.fn().mockResolvedValue({
      replayed: false,
      sessionHandoff: {
        type: "redirect",
        url: "https://evil.example/session/handoff?token=do-not-relay",
      },
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
