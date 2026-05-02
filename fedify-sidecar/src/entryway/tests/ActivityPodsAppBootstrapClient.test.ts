import { describe, expect, it, vi } from "vitest";
import { ActivityPodsAppBootstrapClient } from "../ActivityPodsAppBootstrapClient.js";

describe("ActivityPodsAppBootstrapClient", () => {
  it("calls the configured provider bootstrap path and returns only sanitized handoff metadata", async () => {
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
        headers: expect.objectContaining({
          authorization: "Bearer provider-token",
        }),
      }),
    );
    expect(result.snapshot).toEqual({
      status: "ready",
      appClientId: "https://memory.example/app",
      appRegistrationUri: "http://localhost:3000/alice/data/app-registration-memory",
      accessGrantUris: ["http://localhost:3000/alice/data/grant-memory"],
      bootstrappedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.sessionHandoff).toEqual({
      type: "redirect",
      url: "https://memory.example/session/handoff?id=abc",
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
