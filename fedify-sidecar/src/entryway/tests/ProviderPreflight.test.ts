import { describe, expect, it, vi } from "vitest";
import { ActivityPodsProvisioningClient } from "../ActivityPodsProvisioningClient.js";
import { ProviderCapabilitiesPreflight } from "../ProviderPreflight.js";

const provider = {
  providerId: "default",
  baseUrl: "http://localhost:3000",
  provisioningBearerToken: "provider-token",
  appClientId: "https://memory.example/app",
};

describe("ProviderCapabilitiesPreflight", () => {
  it("accepts a provider that advertises secure account provisioning for the requested protocols", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, capabilitiesDoc()));
    const preflight = createPreflight(fetchMock as unknown as typeof fetch);

    const checks = await preflight.assertProviderReady(provider, {
      solid: true,
      activitypub: true,
      atproto: true,
    });

    expect(checks.map((check) => check.name)).toContain("provider_account_provisioning_enabled");
    expect(checks.map((check) => check.name)).toContain("provider_protocol_bundle_supported");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects providers that do not require approved apps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, capabilitiesDoc({
      accountLimits: { approvedAppsRequired: false },
    })));
    const preflight = createPreflight(fetchMock as unknown as typeof fetch);

    await expect(preflight.assertProviderReady(provider, {
      solid: true,
      activitypub: true,
      atproto: false,
    })).rejects.toMatchObject({
      code: "provider_approved_apps_not_required",
      retryable: false,
    });
  });

  it("rejects ATProto signup when provider ATProto support is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, capabilitiesDoc({
      atprotoEnabled: false,
      supportedProtocolSet: "solid,activitypub",
    })));
    const preflight = createPreflight(fetchMock as unknown as typeof fetch);

    await expect(preflight.assertProviderReady(provider, {
      solid: true,
      activitypub: true,
      atproto: true,
    })).rejects.toMatchObject({
      code: "provider_protocol_unsupported",
    });
  });

  it("caches successful provider preflight results briefly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, capabilitiesDoc()));
    const preflight = createPreflight(fetchMock as unknown as typeof fetch);

    await preflight.assertProviderReady(provider, {
      solid: true,
      activitypub: true,
      atproto: true,
    });
    await preflight.assertProviderReady(provider, {
      solid: true,
      activitypub: true,
      atproto: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function createPreflight(fetchFn: typeof fetch) {
  const client = new ActivityPodsProvisioningClient({
    fetchFn,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  return new ProviderCapabilitiesPreflight(client, {
    successTtlMs: 60_000,
    failureTtlMs: 1,
  });
}

function capabilitiesDoc(options: {
  accountLimits?: Record<string, unknown>;
  atprotoEnabled?: boolean;
  supportedProtocolSet?: string;
} = {}) {
  return {
    schemaVersion: "1.0.0",
    provider: {
      id: "pods.example",
      displayName: "Example Pods",
      region: "local",
    },
    protocols: {
      activitypub: {
        enabled: true,
        status: "enabled",
      },
      atproto: {
        enabled: options.atprotoEnabled !== false,
        status: options.atprotoEnabled === false ? "disabled" : "enabled",
      },
    },
    capabilities: [
      {
        id: "provider.account.provisioning",
        version: "1.0.0",
        status: "enabled",
        dependencies: [],
        limits: {
          approvedAppsRequired: true,
          requiresUserVerification: true,
          supportedProtocolSet: options.supportedProtocolSet ?? "solid,activitypub,atproto",
          ...options.accountLimits,
        },
      },
    ],
    security: {
      failClosed: true,
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
