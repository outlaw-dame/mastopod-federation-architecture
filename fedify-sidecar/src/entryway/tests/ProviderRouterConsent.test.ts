import { describe, expect, it } from "vitest";
import {
  StaticEntrywayProviderRouter,
  buildNativeSaiAuthorizationUrl,
  normalizeProviderDefinition,
} from "../ProviderRouter.js";
import { buildEntrywayProvidersFromEnv } from "../config.js";
import type { EntrywayProviderDefinition } from "../types.js";

function provider(overrides: Partial<EntrywayProviderDefinition> = {}): EntrywayProviderDefinition {
  return {
    providerId: "pods-eu",
    baseUrl: "https://pods.example.org",
    provisioningBearerToken: "not-displayed-provider-bearer",
    appClientId: "https://memory.example.org/account-client",
    appBootstrapEnabled: true,
    appBootstrapPath: "/api/internal/entryway/app-bootstrap",
    saiAuthorizationUrl: "https://id.pods.example.org/authorize",
    saiAppUri: "https://memory.example.org/sai/app#main",
    ...overrides,
  };
}

describe("operator-pinned native Solid SAI consent navigation", () => {
  it("pins owner-session issuer and JWKS to the canonical provider HTTPS origin", () => {
    const normalized = normalizeProviderDefinition(provider({
      ownerSessionIssuer: "https://pods.example.org",
      ownerSessionJwksUrl: "https://pods.example.org/.well-known/jwks.json",
    }));
    expect(normalized.ownerSessionAudience).toBe("urn:paper:entryway:owner-session:v1");
    expect(normalized.ownerSessionJwksUrl).toBe("https://pods.example.org/.well-known/jwks.json");
  });

  it.each([
    { ownerSessionIssuer: "http://pods.example.org", ownerSessionJwksUrl: "https://pods.example.org/jwks" },
    { ownerSessionIssuer: "https://pods.example.org", ownerSessionJwksUrl: "https://evil.example/jwks" },
    { ownerSessionIssuer: "https://pods.example.org/", ownerSessionJwksUrl: "https://pods.example.org/jwks" },
    { ownerSessionIssuer: "https://pods.example.org", ownerSessionJwksUrl: undefined },
    { ownerSessionIssuer: undefined, ownerSessionJwksUrl: "https://pods.example.org/jwks" },
  ])("rejects incomplete or cross-origin owner-session authority: %j", override => {
    expect(() => normalizeProviderDefinition(provider(override)))
      .toThrowError(/Owner-session proof/);
  });

  it("uses the exact approved SAI app resource, never a guessed signup app client", () => {
    const entry = normalizeProviderDefinition(provider());
    const url = buildNativeSaiAuthorizationUrl(entry);
    expect(url).toBe(
      "https://id.pods.example.org/authorize?client_id=https%3A%2F%2Fmemory.example.org%2Fsai%2Fapp%23main",
    );
    expect(url).not.toContain("account-client");
    expect(url).not.toContain("not-displayed-provider-bearer");
  });

  it("is optional, with no guessed path when the provider has not configured it", () => {
    const router = new StaticEntrywayProviderRouter([
      provider({ saiAuthorizationUrl: undefined, saiAppUri: undefined }),
    ]);
    const normalized = router.getProvider("pods-eu");
    expect(normalized).not.toBeNull();
    expect(buildNativeSaiAuthorizationUrl(normalized!)).toBeUndefined();
  });

  it.each([
    { saiAuthorizationUrl: "javascript:alert(1)" },
    { saiAuthorizationUrl: "http://id.example.org/authorize" },
    { saiAuthorizationUrl: "https://username:secret@id.example.org/authorize" },
    { saiAuthorizationUrl: "https://id.example.org/authorize?next=https://evil.example" },
    { saiAuthorizationUrl: "https://id.example.org/authorize#fragment" },
    { saiAuthorizationUrl: "https://id.example.org/signin" },
    { saiAuthorizationUrl: "https://id.example.org/authorize", saiAppUri: "javascript:alert(1)" },
    { saiAuthorizationUrl: "https://id.example.org/authorize", saiAppUri: "http://insecure.example/app" },
    { saiAuthorizationUrl: "https://id.example.org/authorize", saiAppUri: "https://user:pass@example.org/app" },
    { saiAuthorizationUrl: "https://id.example.org/authorize", saiAppUri: undefined },
    { saiAuthorizationUrl: undefined, saiAppUri: "https://memory.example.org/app" },
  ])("rejects untrusted/incomplete consent navigation configuration: %j", override => {
    expect(() => normalizeProviderDefinition(provider(override))).toThrowError(/Native SAI/);
  });

  it("parses the explicit SAI fields from both default and provider-array configuration", () => {
    const defaultProvider = buildEntrywayProvidersFromEnv({
      ENTRYWAY_DEFAULT_PROVIDER_URL: "https://pods.example.org",
      ENTRYWAY_PROVIDER_PROVISIONING_TOKEN: "secret",
      ENTRYWAY_APP_CLIENT_ID: "https://memory.example.org/account-client",
      ENTRYWAY_SAI_AUTHORIZATION_URL: "https://id.pods.example.org/authorize",
      ENTRYWAY_SAI_APP_URI: "https://memory.example.org/sai/app#main",
      ENTRYWAY_OWNER_SESSION_ISSUER: "https://pods.example.org",
      ENTRYWAY_OWNER_SESSION_JWKS_URL: "https://pods.example.org/.well-known/jwks.json",
    });
    expect(defaultProvider).toHaveLength(1);
    expect(normalizeProviderDefinition(defaultProvider[0]!).saiAppUri)
      .toBe("https://memory.example.org/sai/app#main");
    expect(normalizeProviderDefinition(defaultProvider[0]!).ownerSessionIssuer)
      .toBe("https://pods.example.org");

    const array = buildEntrywayProvidersFromEnv({
      ENTRYWAY_PROVIDERS_JSON: JSON.stringify([provider()]),
    });
    expect(array).toHaveLength(1);
    expect(buildNativeSaiAuthorizationUrl(normalizeProviderDefinition(array[0]!)))
      .toContain("client_id=");
  });
});
