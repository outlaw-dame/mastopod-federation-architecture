import { describe, expect, it, vi } from "vitest";
import { AccountBundleVerifier } from "../AccountBundleVerifier.js";
import type { AccountRoute } from "../types.js";

const base = "http://localhost:3000";
function route(overrides: Partial<AccountRoute> = {}): AccountRoute {
  return {
    accountId: "acct_11111111-1111-4111-8111-111111111111",
    canonicalAccountId: `${base}/alice/profile/card#me`,
    username: "alice",
    handle: "@alice@localhost",
    webId: `${base}/alice/profile/card#me`,
    actorId: `${base}/alice`,
    podStorageUrl: `${base}/alice/data/`,
    providerId: "default",
    providerBaseUrl: base,
    oidcIssuer: base,
    status: "provisioning",
    provisioning: {
      phase: "POD_ACCOUNT_CREATED",
      attempts: 1,
      idempotencyKeyHash: "hash",
      requestFingerprint: "fingerprint",
      checks: [],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fetchFixture(actorResponse?: Response) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    expect(init?.redirect).toBe("manual");
    if (href === `${base}/.well-known/openid-configuration`) {
      return json({ issuer: base });
    }
    if (href === `${base}/alice/profile/card`) {
      return new Response("<#me> a <http://xmlns.com/foaf/0.1/Person> .", { status: 200 });
    }
    if (href === `${base}/alice`) {
      return actorResponse ?? json({
        type: "Person",
        id: `${base}/alice`,
        inbox: `${base}/alice/inbox`,
        outbox: `${base}/alice/outbox`,
        followers: `${base}/alice/followers`,
        following: `${base}/alice/following`,
      });
    }
    throw new Error("Unexpected destination");
  });
  return { fetchMock, calls };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

describe("AccountBundleVerifier HTTP boundaries", () => {
  it("verifies canonical provider-owned identities without following redirects", async () => {
    const { fetchMock, calls } = fetchFixture();
    const verifier = new AccountBundleVerifier({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await verifier.verify(route());
    expect(result.passed).toBe(true);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    expect(calls).toContain(`${base}/alice`);
    expect(calls).toHaveLength(3);
  });

  it("never fetches an actor outside the selected provider origin", async () => {
    const { fetchMock, calls } = fetchFixture();
    const verifier = new AccountBundleVerifier({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await verifier.verify(route({
      actorId: "http://169.254.169.254/latest/meta-data/",
    }));
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "activitypub_actor_valid")).toMatchObject({
      status: "failed",
    });
    expect(calls).not.toContain("http://169.254.169.254/latest/meta-data/");
    expect(calls).toHaveLength(2);
  });

  it("does not follow an actor redirect to internal metadata endpoints", async () => {
    const { fetchMock, calls } = fetchFixture(new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    }));
    const verifier = new AccountBundleVerifier({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await verifier.verify(route());
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "activitypub_actor_valid")?.status).toBe("failed");
    expect(calls).toHaveLength(3);
    expect(calls).not.toContain("http://169.254.169.254/latest/meta-data/");
  });

  it("fails verification on an oversized actor document", async () => {
    const { fetchMock } = fetchFixture(json({
      id: `${base}/alice`,
      type: "Person",
      summary: "x".repeat(1024 * 1024 + 1),
    }));
    const verifier = new AccountBundleVerifier({
      fetchFn: fetchMock as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await verifier.verify(route());
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "activitypub_actor_valid")?.status).toBe("failed");
  });
});
