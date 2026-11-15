import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ActivityPodsAppBootstrapClient } from "../ActivityPodsAppBootstrapClient.js";

describe("ActivityPodsAppBootstrapClient", () => {
  it("requires real SAI grant resources and drops unverified provider session-handoff metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
      accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
      bootstrappedAt: "2026-01-01T00:00:00.000Z",
      sessionHandoff: {
        type: "redirect",
        url: "https://memory.example/session/handoff?id=abc",
        expiresAt: "2026-01-01T00:05:00.000Z",
        accessJwt: "must-not-surface",
      },
    }));
    const client = new ActivityPodsAppBootstrapClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    const result = await client.bootstrap({
      provider: {
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      },
      route: {
        accountId: "acct_11111111-1111-4111-8111-111111111111",
        canonicalAccountId: "http://localhost:3000/alice/profile/card#me",
        username: "alice",
        handle: "@alice@localhost",
        webId: "http://localhost:3000/alice/profile/card#me",
        actorId: "http://localhost:3000/alice",
        podStorageUrl: "http://localhost:3000/alice/data/",
        providerId: "default",
        providerBaseUrl: "http://localhost:3000",
        oidcIssuer: "http://localhost:3000",
        status: "provisioning",
        provisioning: {
          phase: "ACTOR_VALIDATED",
          attempts: 1,
          idempotencyKeyHash: "hash",
          requestFingerprint: "fingerprint",
          checks: [],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/internal/entryway/app-bootstrap",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: expect.objectContaining({
          authorization: "Bearer provider-token",
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody["idempotencyKey"]).toBe(
      "entryway:acct_11111111-1111-4111-8111-111111111111:" +
      createHash("sha256").update("hash").digest("hex").slice(0, 24),
    );
    expect(JSON.stringify(requestBody)).not.toContain("fingerprint");
    expect(requestBody["webId"]).toBe("http://localhost:3000/alice/profile/card#me");
    expect(requestBody["actorId"]).toBe("http://localhost:3000/alice");

    expect(result.snapshot).toEqual({
      status: "ready",
      appClientId: "https://memory.example/app",
      appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
      accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
      bootstrappedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("sessionHandoff");
    expect(JSON.stringify(result)).not.toContain("session/handoff");
    expect(JSON.stringify(result)).not.toContain("must-not-surface");
  });
  it.each([
    ["empty HTTP 200", {}],
    ["missing registration", { accessGrantUris: [] }],
    ["missing grant collection", {
      appRegistrationUri: "http://localhost:3000/alice/data/registration"
    }],
    ["cross-account registration", {
      appRegistrationUri: "http://localhost:3000/bob/data/registration", accessGrantUris: [],
    }],
    ["cross-account grant", {
      appRegistrationUri: "http://localhost:3000/alice/data/registration",
      accessGrantUris: ["http://localhost:3000/bob/data/grant"],
    }],
    ["cross-provider origin", {
      appRegistrationUri: "https://evil.example/alice/data/registration",
      accessGrantUris: [],
    }],
    ["invalid scheme", {
      appRegistrationUri: "javascript:alert(1)", accessGrantUris: [],
    }],
    ["credential-bearing URL", {
      appRegistrationUri: "http://admin:secret@localhost:3000/alice/data/registration",
      accessGrantUris: [],
    }],
    ["query-injected grant URI", {
      appRegistrationUri: "http://localhost:3000/alice/data/registration",
      accessGrantUris: ["http://localhost:3000/alice/data/grant?token=secret"],
    }],
    ["duplicate grant", {
      appRegistrationUri: "http://localhost:3000/alice/data/registration",
      accessGrantUris: [
        "http://localhost:3000/alice/data/grant",
        "http://localhost:3000/alice/data/grant",
      ],
    }],
    ["silent filtering of invalid grants", {
      appRegistrationUri: "http://localhost:3000/alice/data/registration",
      accessGrantUris: [false],
    }],
    ["oversized grant list", {
      appRegistrationUri: "http://localhost:3000/alice/data/registration",
      accessGrantUris: Array(129).fill("http://localhost:3000/alice/data/grant"),
    }],
  ])("fails closed on %s provider SAI proof", async (_name, body) => {
    const client = new ActivityPodsAppBootstrapClient({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(200, body)) as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const provider = {
      providerId: "default",
      baseUrl: "http://localhost:3000",
      provisioningBearerToken: "provider-token",
      appClientId: "https://memory.example/app",
      appBootstrapEnabled: true,
      appBootstrapPath: "/api/internal/entryway/app-bootstrap",
    };
    const route = {
      accountId: "acct_11111111-1111-4111-8111-111111111111",
      canonicalAccountId: "http://localhost:3000/alice/profile/card#me",
      username: "alice",
      handle: "@alice@localhost",
      webId: "http://localhost:3000/alice/profile/card#me",
      actorId: "http://localhost:3000/alice",
      podStorageUrl: "http://localhost:3000/alice/data/",
      providerId: "default", providerBaseUrl: "http://localhost:3000",
      oidcIssuer: "http://localhost:3000",
      status: "provisioning" as const,
      provisioning: {
        phase: "ACTOR_VALIDATED" as const, attempts: 1,
        idempotencyKeyHash: "hash", requestFingerprint: "fingerprint", checks: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(client.bootstrap({ provider, route })).rejects.toMatchObject({
      code: "app_bootstrap_invalid_response", statusCode: 502, retryable: false,
    });
  });

  it("allows a genuine owner registration with no optional grants, but never treats a blank 200 as consent", async () => {
    const client = new ActivityPodsAppBootstrapClient({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(200, {
        appRegistrationUri: "http://localhost:3000/alice/data/registration",
        accessGrantUris: [],
      })) as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const provider = {
      providerId: "default", baseUrl: "http://localhost:3000",
      provisioningBearerToken: "provider-token",
      appClientId: "https://memory.example/app", appBootstrapEnabled: true,
      appBootstrapPath: "/api/internal/entryway/app-bootstrap",
    };
    const route = {
      accountId: "acct_11111111-1111-4111-8111-111111111111",
      canonicalAccountId: "http://localhost:3000/alice/profile/card#me",
      username: "alice", handle: "@alice@localhost",
      webId: "http://localhost:3000/alice/profile/card#me",
      actorId: "http://localhost:3000/alice",
      podStorageUrl: "http://localhost:3000/alice/data/",
      providerId: "default", providerBaseUrl: "http://localhost:3000",
      oidcIssuer: "http://localhost:3000",
      status: "provisioning" as const,
      provisioning: {
        phase: "ACTOR_VALIDATED" as const, attempts: 1,
        idempotencyKeyHash: "hash", requestFingerprint: "fingerprint", checks: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await client.bootstrap({ provider, route });
    expect(result.snapshot).toMatchObject({
      status: "ready",
      appRegistrationUri: "http://localhost:3000/alice/data/registration",
      accessGrantUris: [],
    });
    expect(result).not.toHaveProperty("sessionHandoff");
  });

  it("converts native SAI consent-required HTTP 428 into a safe resumable signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "password=must-not-leak", consentUrl: "https://evil.example/steal" }),
      { status: 428, headers: { "content-type": "application/json" } },
    ));
    const client = new ActivityPodsAppBootstrapClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const route = {
      accountId: "acct_11111111-1111-4111-8111-111111111111",
      canonicalAccountId: "http://localhost:3000/alice/profile/card#me",
      username: "alice",
      handle: "@alice@localhost",
      webId: "http://localhost:3000/alice/profile/card#me",
      actorId: "http://localhost:3000/alice",
      podStorageUrl: "http://localhost:3000/alice/data/",
      providerId: "default",
      providerBaseUrl: "http://localhost:3000",
      oidcIssuer: "http://localhost:3000",
      status: "provisioning" as const,
      provisioning: {
        phase: "ACTOR_VALIDATED" as const,
        attempts: 1,
        idempotencyKeyHash: "hash",
        requestFingerprint: "fingerprint",
        checks: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(client.bootstrap({
      provider: {
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      },
      route,
    })).rejects.toMatchObject({
      code: "app_consent_required",
      message: "Pod owner authorization is required",
      statusCode: 428,
      retryable: false,
      details: { providerStatus: 428 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["plain text", new Response("password=leaked-secret", { status: 502, headers: { "content-type": "text/plain" } })],
    ["malformed JSON", new Response('{"accessJwt":"leaked-secret"', { status: 502, headers: { "content-type": "application/json" } })],
    ["structured JSON", jsonResponse(502, { error: "leaked-secret", message: "password=leaked-secret", accessJwt: "leaked-secret" })],
  ])("does not expose %s provider error bodies", async (_label, providerResponse) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse);
    const client = new ActivityPodsAppBootstrapClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    await expect(client.bootstrap({
      provider: {
        providerId: "default",
        baseUrl: "http://localhost:3000",
        provisioningBearerToken: "provider-token",
        appClientId: "https://memory.example/app",
        appBootstrapEnabled: true,
        appBootstrapPath: "/api/internal/entryway/app-bootstrap",
      },
      route: {
        accountId: "acct_11111111-1111-4111-8111-111111111111",
        canonicalAccountId: "http://localhost:3000/alice/profile/card#me",
        username: "alice",
        handle: "@alice@localhost",
        webId: "http://localhost:3000/alice/profile/card#me",
        actorId: "http://localhost:3000/alice",
        podStorageUrl: "http://localhost:3000/alice/data/",
        providerId: "default",
        providerBaseUrl: "http://localhost:3000",
        oidcIssuer: "http://localhost:3000",
        status: "provisioning",
        provisioning: {
          phase: "ACTOR_VALIDATED",
          attempts: 1,
          idempotencyKeyHash: "hash",
          requestFingerprint: "fingerprint",
          checks: [],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    })).rejects.toMatchObject({
      code: "app_bootstrap_failed",
      message: "Provider app bootstrap failed with HTTP 502",
      details: { providerStatus: 502 },
    });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
