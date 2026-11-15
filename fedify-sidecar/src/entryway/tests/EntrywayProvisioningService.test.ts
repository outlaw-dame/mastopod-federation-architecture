import { describe, expect, it, vi } from "vitest";
import { ActivityPodsProvisioningClient } from "../ActivityPodsProvisioningClient.js";
import type { EntrywayAppBootstrapper } from "../ActivityPodsAppBootstrapClient.js";
import { AccountBundleVerifier } from "../AccountBundleVerifier.js";
import { InMemoryAccountRouteStore } from "../AccountRouteStore.js";
import { EntrywayProvisioningService } from "../EntrywayProvisioningService.js";
import { StaticEntrywayProviderRouter } from "../ProviderRouter.js";
import { EntrywayError } from "../errors.js";
import type { EntrywayProviderPreflight } from "../ProviderPreflight.js";

const fingerprintSecret = "test-entryway-fingerprint-secret-minimum-32-chars";

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    username: "Alice",
    email: "alice@example.com",
    password: "CorrectHorseBatteryStaple1",
    profile: {
      displayName: "Alice",
      summary: "Entryway test account",
    },
    protocols: {
      solid: true,
      activitypub: true,
      atproto: {
        enabled: true,
        didMethod: "did:plc" as const,
      },
    },
    idempotencyKey: "idem.alice.0001",
    verification: {
      method: "email",
      challengeToken: "verified-user-token",
    },
    ...overrides,
  };
}

function providerResult(username = "alice") {
  return {
    canonicalAccountId: `http://localhost:3000/${username}/profile/card#me`,
    webId: `http://localhost:3000/${username}/profile/card#me`,
    activitypub: {
      actorId: `http://localhost:3000/${username}`,
      handle: `@${username}@localhost`,
      inbox: `http://localhost:3000/${username}/inbox`,
      outbox: `http://localhost:3000/${username}/outbox`,
    },
    solid: {
      webId: `http://localhost:3000/${username}/profile/card#me`,
      podBaseUrl: `http://localhost:3000/${username}/data/`,
    },
    atproto: {
      did: "did:plc:alice123",
      handle: `${username}.test`,
    },
  };
}

function createFetchMock(options?: { invalidActor?: boolean }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: href, init });

    if (href.endsWith("/api/accounts/create")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body["password"]).toBe("CorrectHorseBatteryStaple1");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer provider-provisioning-token",
        "idempotency-key": expect.stringMatching(/^entryway:acct_/),
      });
      return jsonResponse(201, providerResult(String(body["username"] ?? "alice").toLowerCase()));
    }

    if (href === "http://localhost:3000/.well-known/openid-configuration") {
      return jsonResponse(200, { issuer: "http://localhost:3000" });
    }

    if (href === "http://localhost:3000/alice") {
      return jsonResponse(200, {
        id: "http://localhost:3000/alice",
        type: "Person",
        inbox: "http://localhost:3000/alice/inbox",
        outbox: "http://localhost:3000/alice/outbox",
        followers: options?.invalidActor ? undefined : "http://localhost:3000/alice/followers",
        following: "http://localhost:3000/alice/following",
        publicKey: {
          id: "http://localhost:3000/alice#main-key",
          owner: "http://localhost:3000/alice",
          publicKeyPem: "-----BEGIN PUBLIC KEY-----\nmock\n-----END PUBLIC KEY-----",
        },
      });
    }

    if (href === "http://localhost:3000/alice/profile/card") {
      return new Response("<#me> a <http://xmlns.com/foaf/0.1/Person> .", { status: 200 });
    }

    return jsonResponse(404, { error: "not_found" });
  });

  return { fetchMock, calls };
}

function createService(fetchFn: typeof fetch, options: {
  providerPreflight?: EntrywayProviderPreflight;
  appBootstrapper?: EntrywayAppBootstrapper;
  providers?: ConstructorParameters<typeof StaticEntrywayProviderRouter>[0];
  store?: InMemoryAccountRouteStore;
} = {}) {
  return new EntrywayProvisioningService({
    store: options.store ?? new InMemoryAccountRouteStore(),
    providerRouter: new StaticEntrywayProviderRouter(options.providers ?? [
      {
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        origin: "https://memory.example",
        appBootstrapEnabled: false,
      },
    ]),
    providerClient: new ActivityPodsProvisioningClient({
      fetchFn,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    verifier: new AccountBundleVerifier({
      fetchFn,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    providerPreflight: options.providerPreflight,
    appBootstrapper: options.appBootstrapper,
    fingerprintSecret,
  });
}

async function consentPendingFixture() {
  const { fetchMock, calls } = createFetchMock();
  const store = new InMemoryAccountRouteStore();
  const ready = {
    snapshot: {
      status: "ready" as const,
      appClientId: "https://memory.example/app",
      appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
      accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
    },
  };
  const appBootstrapper = {
    bootstrap: vi.fn()
      .mockRejectedValueOnce(new EntrywayError(
        "app_consent_required", "Native Pod-owner authorization required",
        { statusCode: 428, retryable: false },
      ))
      .mockResolvedValue(ready),
  };
  const provider = {
    providerId: "default",
    baseUrl: "http://localhost:3000",
    provisioningBearerToken: "provider-provisioning-token",
    appClientId: "https://memory.example/app",
    appBootstrapEnabled: true,
    appBootstrapPath: "/api/internal/entryway/app-bootstrap",
    saiAuthorizationUrl: "https://id.pods.example/authorize",
    saiAppUri: "https://memory.example/app",
  };
  const service = createService(fetchMock as unknown as typeof fetch, {
    store, appBootstrapper, providers: [provider],
  });
  await expect(service.createAccount(createInput())).rejects.toMatchObject({
    code: "app_consent_required",
    statusCode: 428,
  });
  return { service, store, appBootstrapper, ready, provider, calls, fetchMock };
}

const consentResume = {
  username: "Alice",
  appClientId: "https://memory.example/app",
  idempotencyKey: "idem.alice.0001",
};

describe("EntrywayProvisioningService", () => {
  it("creates an active route only after provider provisioning and bundle verification", async () => {
    const { fetchMock, calls } = createFetchMock();
    const service = createService(fetchMock as unknown as typeof fetch);

    const result = await service.createAccount(createInput());

    expect(result.replayed).toBe(false);
    expect(result.route.status).toBe("active");
    expect(result.route.username).toBe("alice");
    expect(result.route.webId).toBe("http://localhost:3000/alice/profile/card#me");
    expect(result.route.actorId).toBe("http://localhost:3000/alice");
    expect(result.route.followers).toBe("http://localhost:3000/alice/followers");
    expect(result.route.atprotoDid).toBe("did:plc:alice123");
    expect(result.route.provisioning.phase).toBe("ACTIVE");
    expect(result.route.provisioning.checks.every((check) => check.status === "passed")).toBe(true);
    expect(JSON.stringify(result.route)).not.toContain("CorrectHorseBatteryStaple1");
    expect(calls.filter((call) => call.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("replays a completed idempotent request without calling the provider again", async () => {
    const { fetchMock, calls } = createFetchMock();
    const service = createService(fetchMock as unknown as typeof fetch);

    await service.createAccount(createInput());
    const replay = await service.createAccount(createInput());

    expect(replay.replayed).toBe(true);
    expect(replay.route.status).toBe("active");
    expect(calls.filter((call) => call.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("rejects same idempotency key with a different payload", async () => {
    const { fetchMock } = createFetchMock();
    const service = createService(fetchMock as unknown as typeof fetch);

    await service.createAccount(createInput());

    await expect(
      service.createAccount(createInput({ email: "alice2@example.com" })),
    ).rejects.toMatchObject({
      code: "idempotency_key_conflict",
      statusCode: 409,
    });
  });

  it("marks the route failed when actor bundle verification fails", async () => {
    const { fetchMock } = createFetchMock({ invalidActor: true });
    const service = createService(fetchMock as unknown as typeof fetch);

    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "bundle_verification_failed",
      retryable: true,
    });

    const route = await service.getByUsername("alice");
    expect(route?.status).toBe("failed");
    expect(route?.provisioning.lastErrorCode).toBe("bundle_verification_failed");
    expect(route?.provisioning.checks.find((check) => check.name === "activitypub_actor_valid")?.status).toBe("failed");
  });

  it("skips a provider that fails preflight and provisions on the next eligible provider", async () => {
    const { fetchMock } = createFetchMock();
    const providerPreflight = {
      assertProviderReady: vi.fn(async (provider) => {
        if (provider.providerId === "primary") {
          throw new EntrywayError("provider_provisioning_disabled", "Provider provisioning disabled", {
            statusCode: 503,
            retryable: true,
          });
        }
        return [{
          name: "provider_account_provisioning_enabled",
          status: "passed" as const,
          checkedAt: new Date().toISOString(),
        }];
      }),
    };
    const service = createService(fetchMock as unknown as typeof fetch, {
      providerPreflight,
      providers: [
        {
          providerId: "primary",
          baseUrl: "http://localhost:3000",
          provisioningBearerToken: "provider-provisioning-token",
          appClientId: "https://memory.example/app",
          origin: "https://memory.example",
        },
        {
          providerId: "backup",
          baseUrl: "http://localhost:3000",
          provisioningBearerToken: "provider-provisioning-token",
          appClientId: "https://memory.example/app",
          origin: "https://memory.example",
        },
      ],
    });

    const result = await service.createAccount(createInput());

    expect(providerPreflight.assertProviderReady).toHaveBeenCalledTimes(2);
    expect(result.route.providerId).toBe("backup");
    expect(result.route.status).toBe("active");
  });

  it("bootstraps the app before activation when the provider requires it", async () => {
    const { fetchMock } = createFetchMock();
    const appBootstrapper = {
      bootstrap: vi.fn().mockResolvedValue({
        snapshot: {
          status: "ready",
          appClientId: "https://memory.example/app",
          appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
          accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
          bootstrappedAt: "2026-01-01T00:00:00.000Z",
        },
        sessionHandoff: {
          type: "handoff",
          handoffId: "handoff-123",
          expiresAt: "2026-01-01T00:05:00.000Z",
        },
      }),
    };
    const service = createService(fetchMock as unknown as typeof fetch, {
      appBootstrapper,
      providers: [
        {
          providerId: "default",
          baseUrl: "http://localhost:3000",
          provisioningBearerToken: "provider-provisioning-token",
          appClientId: "https://memory.example/app",
          origin: "https://memory.example",
          appBootstrapEnabled: true,
          appBootstrapPath: "/api/internal/entryway/app-bootstrap",
        },
      ],
    });

    const result = await service.createAccount(createInput());

    expect(appBootstrapper.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({ providerId: "default" }),
      route: expect.objectContaining({ webId: "http://localhost:3000/alice/profile/card#me" }),
    }));
    expect(result.route.status).toBe("active");
    expect(result.route.appBootstrap).toMatchObject({
      status: "ready",
      appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
      accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
    });
    expect(result).not.toHaveProperty("sessionHandoff");
    expect(JSON.stringify(result.route)).not.toContain("handoff-123");
  });

  it("never activates a bootstrapper that claims ready without the owner registration", async () => {
    const { fetchMock, calls } = createFetchMock();
    const service = createService(fetchMock as unknown as typeof fetch, {
      appBootstrapper: {
        bootstrap: vi.fn().mockResolvedValue({
          snapshot: {
            status: "ready" as const,
            appClientId: "https://memory.example/app",
            accessGrantUris: [],
          },
          sessionHandoff: {
            type: "redirect", url: "https://evil.example/session/token",
          },
        }),
      },
      providers: [{
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      }],
    });
    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "app_bootstrap_invalid_response",
    });
    const route = await service.getByUsername("alice");
    expect(route?.status).toBe("failed");
    expect(route?.provisioning.phase).toBe("FAILED");
    expect(JSON.stringify(route)).not.toContain("evil.example");
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("holds a completed Pod account for native SAI consent and resumes without a second signup", async () => {
    const { fetchMock, calls } = createFetchMock();
    const store = new InMemoryAccountRouteStore();
    const grantResponse = {
      snapshot: {
        status: "ready" as const,
        appClientId: "https://memory.example/app",
        appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
        accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
      },
    };
    const appBootstrapper = {
      bootstrap: vi.fn()
        .mockRejectedValueOnce(new EntrywayError(
          "app_consent_required",
          "Pod owner authorization is required",
          {
            statusCode: 428,
            retryable: false,
            details: { authorizationUrl: "https://evil.example/authorize?client_id=https://evil.example/app" },
          },
        ))
        .mockResolvedValue(grantResponse),
    };
    const providers = [{
      providerId: "default",
      baseUrl: "http://localhost:3000",
      provisioningBearerToken: "provider-provisioning-token",
      appClientId: "https://memory.example/app",
      appBootstrapEnabled: true,
      appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      saiAuthorizationUrl: "https://id.pods.example.org/authorize",
      saiAppUri: "https://memory.example/app",
    }];
    const service = createService(fetchMock as unknown as typeof fetch, {
      store,
      appBootstrapper,
      providers,
    });

    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "app_consent_required",
      statusCode: 428,
      retryable: false,
      details: {
        authorizationUrl: "https://id.pods.example.org/authorize?client_id=https%3A%2F%2Fmemory.example%2Fapp",
      },
    });
    const waiting = await store.getByUsername("alice");
    expect(waiting).toMatchObject({
      status: "awaiting_consent",
      provisioning: { phase: "AWAITING_APP_CONSENT" },
      appBootstrap: {
        status: "awaiting_consent",
        appClientId: "https://memory.example/app",
        accessGrantUris: [],
      },
    });
    expect(waiting?.webId).toBe("http://localhost:3000/alice/profile/card#me");
    expect(waiting?.revision).toBeGreaterThan(0);
    expect((await store.listStaleProvisioning("2030-01-01T00:00:00.000Z", 25))).toEqual([]);
    expect(calls.filter((call) => call.url.endsWith("/api/accounts/create"))).toHaveLength(1);

    await expect(service.createAccount(createInput({
      email: "changed-owner@example.com",
    }))).rejects.toMatchObject({ code: "idempotency_key_conflict" });

    const resumed = await service.createAccount(createInput());
    expect(resumed.replayed).toBe(true);
    expect(resumed.route.status).toBe("active");
    expect(resumed.route.appBootstrap?.status).toBe("ready");
    expect(resumed.route.revision).toBeGreaterThan(waiting!.revision!);
    expect(calls.filter((call) => call.url.endsWith("/api/accounts/create"))).toHaveLength(1);
    expect(appBootstrapper.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("resumes an authenticated consent-pending signup without password, provider creation or another DID", async () => {
    const { service, store, appBootstrapper, calls } = await consentPendingFixture();
    const awaiting = await store.getByUsername("alice");
    expect(awaiting?.status).toBe("awaiting_consent");
    expect(JSON.stringify(awaiting)).not.toContain("CorrectHorseBatteryStaple1");

    const result = await service.resumeAwaitingConsent(consentResume);
    expect(result.replayed).toBe(true);
    expect(result.route.status).toBe("active");
    expect(result.route.provisioning.phase).toBe("ACTIVE");
    expect(result).not.toHaveProperty("sessionHandoff");
    expect(result.route.revision).toBeGreaterThan(awaiting!.revision!);
    expect(appBootstrapper.bootstrap).toHaveBeenCalledTimes(2);
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
    expect((await store.getByUsername("alice"))?.status).toBe("active");
  });

  it("does not disclose another signup or call provider on wrong idempotency key and app-client scope", async () => {
    const { service, appBootstrapper, calls } = await consentPendingFixture();
    for (const input of [
      { ...consentResume, username: "bob" },
      { ...consentResume, idempotencyKey: "idem.not-alice.12345" },
    ]) {
      await expect(service.resumeAwaitingConsent(input)).rejects.toMatchObject({
        code: "consent_resume_not_found", statusCode: 404,
      });
    }
    await expect(service.resumeAwaitingConsent({
      ...consentResume, appClientId: "https://alternate.example/app",
    })).rejects.toMatchObject({
      code: "app_consent_provider_changed", statusCode: 409,
    });
    expect(appBootstrapper.bootstrap).toHaveBeenCalledTimes(1);
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("does not activate an owner who has not finished native SAI consent", async () => {
    const { service, store, appBootstrapper, calls } = await consentPendingFixture();
    appBootstrapper.bootstrap.mockRejectedValueOnce(new EntrywayError(
      "app_consent_required", "Authorization is still missing",
      { statusCode: 428, retryable: false },
    ));
    await expect(service.resumeAwaitingConsent(consentResume)).rejects.toMatchObject({
      code: "app_consent_required", statusCode: 428,
      details: {
        authorizationUrl: "https://id.pods.example/authorize?client_id=https%3A%2F%2Fmemory.example%2Fapp",
      },
    });
    const awaiting = await store.getByUsername("alice");
    expect(awaiting?.status).toBe("awaiting_consent");
    expect(awaiting?.provisioning.phase).toBe("AWAITING_APP_CONSENT");
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("rechecks current Pod consent when an active signup is replayed", async () => {
    const { service, appBootstrapper, store, calls } = await consentPendingFixture();
    await service.resumeAwaitingConsent(consentResume);
    appBootstrapper.bootstrap.mockRejectedValueOnce(new EntrywayError(
      "app_consent_required", "Owner authorization requires renewal",
      { statusCode: 428, retryable: false },
    ));
    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "app_consent_required", statusCode: 428,
    });
    expect((await store.getByUsername("alice"))?.status).toBe("active");
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
    appBootstrapper.bootstrap.mockResolvedValueOnce({
      snapshot: {
        status: "ready" as const,
        appClientId: "https://memory.example/app",
        accessGrantUris: [],
      },
    });
    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "app_consent_not_verified", statusCode: 409,
    });
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
    const replay = await service.createAccount(createInput());
    expect(replay.replayed).toBe(true);
    expect(replay.route.appBootstrap?.status).toBe("ready");
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("an idempotent resume of an active route rechecks current provider grants without issuing a session", async () => {
    const { service, appBootstrapper, calls } = await consentPendingFixture();
    await service.resumeAwaitingConsent(consentResume);
    const duplicate = await service.resumeAwaitingConsent(consentResume);
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.route.status).toBe("active");
    expect(duplicate).not.toHaveProperty("sessionHandoff");
    expect(appBootstrapper.bootstrap).toHaveBeenCalledTimes(3);
    appBootstrapper.bootstrap.mockRejectedValueOnce(new EntrywayError(
      "app_consent_required", "Grant has been revoked",
      { statusCode: 428, retryable: false },
    ));
    await expect(service.resumeAwaitingConsent(consentResume)).rejects.toMatchObject({
      code: "app_consent_required", statusCode: 428,
    });
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("a competing authenticated worker cannot take an already claimed consent route", async () => {
    const { service, appBootstrapper, store } = await consentPendingFixture();
    let release!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    appBootstrapper.bootstrap.mockImplementationOnce(async () => {
      started();
      await parked;
      return {
        snapshot: {
          status: "ready" as const, appClientId: "https://memory.example/app",
          appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
          accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
        },
      };
    });
    const winner = service.resumeAwaitingConsent(consentResume);
    await reached;
    await expect(service.resumeAwaitingConsent(consentResume)).rejects.toMatchObject({
      code: "consent_not_pending", statusCode: 409,
    });
    release();
    const result = await winner;
    expect(result.route.status).toBe("active");
    expect((await store.getByUsername("alice"))?.status).toBe("active");
  });

  it("rechecks a persisted ready SAI snapshot after a stale worker crash before activation", async () => {
    const { service, store, appBootstrapper, calls } = await consentPendingFixture();
    const pending = await store.getByUsername("alice");
    expect(pending).not.toBeNull();
    await store.save({
      ...pending!,
      status: "provisioning",
      updatedAt: "2025-01-01T00:00:00.000Z",
      appBootstrap: {
        status: "ready",
        appClientId: "https://memory.example/app",
        appRegistrationUri: "http://localhost:3000/alice/data/old-registration",
        accessGrantUris: ["http://localhost:3000/alice/data/now-revoked-grant"],
      },
      provisioning: {
        ...pending!.provisioning,
        phase: "APP_BOOTSTRAP_READY",
      },
    });
    appBootstrapper.bootstrap.mockRejectedValueOnce(new EntrywayError(
      "app_consent_required", "SAI grant has since been revoked",
      { statusCode: 428, retryable: false },
    ));

    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "app_consent_required", statusCode: 428,
    });
    expect((await store.getByUsername("alice"))?.status).toBe("awaiting_consent");
    expect(appBootstrapper.bootstrap).toHaveBeenCalledTimes(2);
    expect(calls.filter(c => c.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("cannot skip pending owner consent by disabling provider bootstrap", async () => {
    const { fetchMock, calls } = createFetchMock();
    const store = new InMemoryAccountRouteStore();
    const first = createService(fetchMock as unknown as typeof fetch, {
      store,
      appBootstrapper: {
        bootstrap: vi.fn().mockRejectedValue(new EntrywayError(
          "app_consent_required", "Pod owner authorization is required",
          { statusCode: 428, retryable: false },
        )),
      },
      providers: [{
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      }],
    });
    await expect(first.createAccount(createInput())).rejects.toMatchObject({
      code: "app_consent_required",
    });
    const changedProvider = createService(fetchMock as unknown as typeof fetch, {
      store,
      providers: [{
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: false,
      }],
    });
    await expect(changedProvider.createAccount(createInput())).rejects.toMatchObject({
      code: "app_consent_provider_changed",
      statusCode: 409,
    });
    expect((await store.getByUsername("alice"))?.status).not.toBe("active");
    expect(calls.filter((call) => call.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("refuses activation when a configured bootstrap provider has no bootstrap client", async () => {
    const { fetchMock } = createFetchMock();
    const service = createService(fetchMock as unknown as typeof fetch, {
      providers: [{
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      }],
    });
    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "app_bootstrap_unavailable",
      statusCode: 503,
    });
    const route = await service.getByUsername("alice");
    expect(route?.status).toBe("failed");
    expect(route?.provisioning.phase).toBe("FAILED");
  });

  it("quarantines an incomplete stale identity and avoids duplicate creation", async () => {
    const { fetchMock, calls } = createFetchMock();
    const store = new InMemoryAccountRouteStore();
    await store.save({ ...staleRoute("default"), actorId: "", podStorageUrl: "" });
    const service = createService(fetchMock as unknown as typeof fetch, { store });
    expect(await service.recoverStaleProvisioning()).toEqual({
      recovered: 0, failed: 1, skipped: 0,
    });
    const route = await store.getByUsername("alice");
    expect(route).toMatchObject({
      status: "reconciliation_required",
      provisioning: {
        phase: "RECONCILIATION_REQUIRED",
        lastErrorCode: "account_identity_incomplete",
      },
    });
    expect(await service.recoverStaleProvisioning()).toEqual({
      recovered: 0, failed: 0, skipped: 0,
    });
    expect(calls).toHaveLength(0);
    vi.spyOn(store, "reserve").mockResolvedValueOnce({ kind: "replayed", route: route! });
    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "account_reconciliation_required", statusCode: 409, retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("never activates a stale provisioned account whose original provider is missing", async () => {
    const { fetchMock, calls } = createFetchMock();
    const store = new InMemoryAccountRouteStore();
    await store.save(staleRoute("removed-provider"));
    const service = createService(fetchMock as unknown as typeof fetch, { store });

    const result = await service.recoverStaleProvisioning();
    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    const route = await store.getByUsername("alice");
    expect(route?.status).toBe("provisioning");
    expect(route?.provisioning.lastErrorCode).toBeUndefined();
    expect(calls).toHaveLength(0);
    // Once provider configuration is restored, a later recovery pass
    // should be able to activate the same bound account without re-signup.
    // Model the next recovery interval after an outage, not an immediate
    // second scan of the newly fenced and timestamp-refreshed attempt.
    const pending = await store.getByUsername("alice");
    expect(pending).not.toBeNull();
    await store.save({ ...pending!, updatedAt: "2026-01-01T00:00:00.000Z" });
    const resumedService = createService(fetchMock as unknown as typeof fetch, {
      store,
      providers: [{
        providerId: "removed-provider",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: false,
      }],
    });
    const resumed = await resumedService.recoverStaleProvisioning();
    expect(resumed.recovered).toBe(1);
    expect((await store.getByUsername("alice"))?.status).toBe("active");
  });

  it("permits one of two concurrent retries to own a failed account", async () => {
    const { fetchMock, calls } = createFetchMock();
    const store = new InMemoryAccountRouteStore();
    let preflightCount = 0;
    const preflight = {
      assertProviderReady: vi.fn(async () => {
        preflightCount += 1;
        if (preflightCount === 1) {
          throw new EntrywayError("temporary_provider_outage", "Provider temporarily unavailable", {
            statusCode: 503, retryable: true,
          });
        }
        return [];
      }),
    };
    const service = createService(fetchMock as unknown as typeof fetch, {
      store,
      providerPreflight: preflight,
    });
    await expect(service.createAccount(createInput())).rejects.toMatchObject({
      code: "provider_not_available",
    });
    const result = await Promise.allSettled([
      service.createAccount(createInput()),
      service.createAccount(createInput()),
    ]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = result.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "provisioning_in_progress", statusCode: 409 });
    const account = await store.getByUsername("alice");
    expect(account?.status).toBe("active");
    expect(account?.revision).toBeGreaterThan(0);
    expect(calls.filter((call) => call.url.endsWith("/api/accounts/create"))).toHaveLength(1);
  });

  it("never reuses another app client's bootstrap grants during recovery", async () => {
    const { fetchMock } = createFetchMock();
    const store = new InMemoryAccountRouteStore();
    await store.save({
      ...staleRoute("default"),
      appBootstrap: {
        status: "ready",
        appClientId: "https://different.example/app",
        accessGrantUris: ["http://localhost:3000/alice/data/foreign-grant"],
      },
    });
    const appBootstrapper = { bootstrap: vi.fn() };
    const service = createService(fetchMock as unknown as typeof fetch, {
      store,
      appBootstrapper,
      providers: [{
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-provisioning-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      }],
    });

    const result = await service.recoverStaleProvisioning();
    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const route = await store.getByUsername("alice");
    expect(route?.status).toBe("failed");
    expect(route?.provisioning.lastErrorCode).toBe("app_consent_provider_changed");
    expect(appBootstrapper.bootstrap).not.toHaveBeenCalled();
  });
});


function staleRoute(providerId: string) {
  return {
    accountId: "acct_11111111-1111-4111-8111-111111111111",
    canonicalAccountId: "http://localhost:3000/alice/profile/card#me",
    username: "alice",
    handle: "@alice@localhost",
    webId: "http://localhost:3000/alice/profile/card#me",
    actorId: "http://localhost:3000/alice",
    podStorageUrl: "http://localhost:3000/alice/data/",
    providerId,
    providerBaseUrl: "http://localhost:3000",
    oidcIssuer: "http://localhost:3000",
    status: "provisioning" as const,
    provisioning: {
      phase: "POD_ACCOUNT_CREATED" as const,
      attempts: 1,
      idempotencyKeyHash: "hash",
      requestFingerprint: "fingerprint",
      checks: [],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
