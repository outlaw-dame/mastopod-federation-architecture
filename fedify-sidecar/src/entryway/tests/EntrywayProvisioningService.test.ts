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
} = {}) {
  return new EntrywayProvisioningService({
    store: new InMemoryAccountRouteStore(),
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
    expect(result.sessionHandoff).toEqual({
      type: "handoff",
      handoffId: "handoff-123",
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
    expect(JSON.stringify(result.route)).not.toContain("handoff-123");
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
