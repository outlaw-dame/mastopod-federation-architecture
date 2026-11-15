import { describe, expect, it, vi } from "vitest";
import { ActivityPodsProvisioningClient } from "../ActivityPodsProvisioningClient.js";

const leakedSecret = "very-private-password-and-challenge";
const provider = {
  providerId: "default",
  baseUrl: "http://localhost:3000",
  provisioningBearerToken: "provider-backend-secret",
  appClientId: "https://memory.example/app",
};

function accountRequest() {
  return {
    provider,
    idempotencyKey: "entryway:acct_11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaa",
    protocols: { solid: true, activitypub: true, atproto: true },
    account: {
      username: "alice",
      email: "alice@example.com",
      password: leakedSecret,
      profile: { displayName: "Alice" },
      verification: { method: "email", challengeToken: leakedSecret },
      idempotencyKey: "private-original-key",
    },
  };
}

describe("ActivityPodsProvisioningClient provider failure isolation", () => {
  it.each([
    ["plaintext", new Response(`password=${leakedSecret}`, { status: 502, headers: { "content-type": "text/plain" } }), 502, true],
    ["malformed JSON", new Response(`{"accessJwt":"${leakedSecret}"`, { status: 502, headers: { "content-type": "application/json" } }), 502, true],
    ["structured JSON", new Response(JSON.stringify({ error: leakedSecret, message: leakedSecret, authorization: leakedSecret }), { status: 403, headers: { "content-type": "application/json" } }), 403, false],
    ["rate limited JSON", new Response(JSON.stringify({ message: leakedSecret }), { status: 429, headers: { "content-type": "application/json" } }), 429, true],
  ])("does not expose %s provider error content", async (_kind, response, status, retryable) => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["password"]).toBe(leakedSecret);
      expect(init?.headers).toMatchObject({ authorization: "Bearer provider-backend-secret" });
      return response;
    });
    const client = new ActivityPodsProvisioningClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    let received: unknown;
    try {
      await client.createAccount(accountRequest());
    } catch (error) {
      received = error;
    }
    expect(received).toMatchObject({
      code: "provider_request_failed",
      message: `Provider request failed with HTTP ${status}`,
      statusCode: status,
      retryable,
      details: { providerStatus: status },
    });
    expect(JSON.stringify(received)).not.toContain(leakedSecret);
    expect(JSON.stringify(received)).not.toContain("provider-backend-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects provider redirects without forwarding the backend bearer", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    });
    const client = new ActivityPodsProvisioningClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(client.createAccount(accountRequest())).rejects.toMatchObject({
      code: "provider_request_failed",
      statusCode: 502,
      retryable: false,
      details: { providerStatus: 302 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized successful provider JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payload: "x".repeat(300_000) }), { status: 200 }),
    );
    const client = new ActivityPodsProvisioningClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(client.createAccount(accountRequest())).rejects.toMatchObject({
      code: "provider_invalid_response",
      statusCode: 502,
    });
  });

  it("never automatically retries a provider account-create POST after an uncertain 503", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    const client = new ActivityPodsProvisioningClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 4 },
    });
    await expect(client.createAccount(accountRequest())).rejects.toMatchObject({
      code: "provider_request_failed", statusCode: 502, retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains bounded retries for safe provider capability GET requests", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    const client = new ActivityPodsProvisioningClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await expect(client.getProviderCapabilities(provider)).rejects.toMatchObject({
      code: "provider_request_failed", statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not reflect credential-bearing provider capability failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: leakedSecret }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ActivityPodsProvisioningClient({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(client.getProviderCapabilities(provider)).rejects.toMatchObject({
      code: "provider_request_failed",
      message: "Provider request failed with HTTP 503",
      details: { providerStatus: 503 },
    });
  });
});
