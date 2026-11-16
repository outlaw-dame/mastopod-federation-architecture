import { EntrywayError } from "./errors.js";
import type {
  EntrywayProviderDefinition,
  EntrywayProviderSelectionInput,
} from "./types.js";
import { isSecureOrTrustedInternalUrl } from "../utils/internalAuthority.js";

export interface EntrywayProviderRouter {
  selectProvider(input: EntrywayProviderSelectionInput): Promise<EntrywayProviderDefinition>;
  listProviders(input: EntrywayProviderSelectionInput): Promise<EntrywayProviderDefinition[]>;
  getProvider(providerId: string): EntrywayProviderDefinition | null;
}

export class StaticEntrywayProviderRouter implements EntrywayProviderRouter {
  private readonly providers: EntrywayProviderDefinition[];

  public constructor(providers: EntrywayProviderDefinition[]) {
    this.providers = providers.map(normalizeProviderDefinition);
  }

  public async selectProvider(input: EntrywayProviderSelectionInput): Promise<EntrywayProviderDefinition> {
    const providers = await this.listProviders(input);
    const provider = providers[0];
    if (provider) {
      return provider;
    }

    throw new EntrywayError("provider_not_configured", "No Entryway provider is configured", {
      statusCode: 503,
      retryable: true,
    });
  }

  public async listProviders(input: EntrywayProviderSelectionInput): Promise<EntrywayProviderDefinition[]> {
    if (input.providerId) {
      const provider = this.getProvider(input.providerId);
      if (!provider || provider.enabled === false) {
        throw new EntrywayError("provider_not_available", "Requested provider is not available", {
          statusCode: 400,
          retryable: false,
          details: { providerId: input.providerId },
        });
      }
      return [provider];
    }

    return this.providers.filter((entry) => entry.enabled !== false);
  }

  public getProvider(providerId: string): EntrywayProviderDefinition | null {
    return this.providers.find((provider) => provider.providerId === providerId) ?? null;
  }
}

export function normalizeProviderDefinition(provider: EntrywayProviderDefinition): EntrywayProviderDefinition {
  const providerId = provider.providerId.trim();
  if (!providerId) {
    throw new EntrywayError("provider_invalid", "Provider id is required", { statusCode: 500 });
  }

  if (!provider.appClientId.trim()) {
    throw new EntrywayError("provider_invalid", "Provider app client id is required", { statusCode: 500 });
  }

  if (!provider.provisioningBearerToken.trim()) {
    throw new EntrywayError("provider_invalid", "Provider provisioning bearer token is required", {
      statusCode: 500,
    });
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
  const sai = normalizeNativeSaiConfig(provider);
  const ownerSession = normalizeOwnerSessionConfig(provider, baseUrl);

  return {
    ...provider,
    ...sai,
    ...ownerSession,
    providerId,
    baseUrl,
    appClientId: provider.appClientId.trim(),
    provisioningBearerToken: provider.provisioningBearerToken.trim(),
    origin: provider.origin?.trim() || undefined,
    redirectUri: provider.redirectUri?.trim() || undefined,
    enabled: provider.enabled !== false,
    appBootstrapPath: normalizeBootstrapPath(provider.appBootstrapPath),
    appBootstrapEnabled: provider.appBootstrapEnabled === true,
  };
}

function normalizeOwnerSessionConfig(
  provider: EntrywayProviderDefinition,
  baseUrl: string,
): Pick<EntrywayProviderDefinition, "ownerSessionIssuer" | "ownerSessionJwksUrl" | "ownerSessionAudience"> {
  const issuer = provider.ownerSessionIssuer?.trim();
  const jwks = provider.ownerSessionJwksUrl?.trim();
  const audience = provider.ownerSessionAudience?.trim() || "urn:paper:entryway:owner-session:v1";
  if (!issuer && !jwks) {
    return { ownerSessionIssuer: undefined, ownerSessionJwksUrl: undefined, ownerSessionAudience: audience };
  }
  if (!issuer || !jwks || audience.length > 256) {
    throw new EntrywayError("provider_invalid", "Owner-session proof requires issuer, JWKS and bounded audience", {
      statusCode: 500,
    });
  }
  try {
    const issuerUrl = new URL(issuer);
    const jwksUrl = new URL(jwks);
    const providerOrigin = new URL(baseUrl).origin;
    const canonicalIssuer = issuer === issuerUrl.origin || issuer === `${issuerUrl.origin}/`;
    if (issuerUrl.protocol !== "https:" || !issuerUrl.hostname || issuerUrl.username || issuerUrl.password ||
        issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash ||
        issuerUrl.origin !== providerOrigin || !canonicalIssuer ||
        jwksUrl.protocol !== "https:" || !jwksUrl.hostname || jwksUrl.username || jwksUrl.password ||
        jwksUrl.search || jwksUrl.hash || jwksUrl.origin !== providerOrigin || jwksUrl.toString() !== jwks) {
      throw new Error("invalid owner-session authority");
    }
  } catch {
    throw new EntrywayError("provider_invalid", "Owner-session proof authority must be canonical HTTPS on the provider origin", {
      statusCode: 500,
    });
  }
  return { ownerSessionIssuer: issuer, ownerSessionJwksUrl: jwks, ownerSessionAudience: audience };
}

/**
 * Only the operator can configure this link. Never discover it from an
 * HTTP 428 body, browser-provided redirect_uri or remote application RDF.
 * A separate SAI app URI is required because the backend signup client ID
 * need not be the Solid Interop app resource.
 */
function normalizeNativeSaiConfig(provider: EntrywayProviderDefinition): {
  saiAuthorizationUrl?: string;
  saiAppUri?: string;
} {
  const authorization = provider.saiAuthorizationUrl?.trim();
  const appUri = provider.saiAppUri?.trim();
  if (!authorization && !appUri) {
    return { saiAuthorizationUrl: undefined, saiAppUri: undefined };
  }
  if (!authorization || !appUri) {
    throw new EntrywayError("provider_invalid", "Native SAI link requires both URL and app URI", {
      statusCode: 500,
    });
  }

  let page: URL;
  let app: URL;
  try {
    page = new URL(authorization);
    app = new URL(appUri);
  } catch {
    throw new EntrywayError("provider_invalid", "Native SAI link has invalid URL", { statusCode: 500 });
  }
  if (page.protocol !== "https:" || !page.hostname ||
      page.username || page.password || page.search || page.hash ||
      !page.pathname.endsWith("/authorize") ||
      page.toString() !== authorization ||
      app.protocol !== "https:" || !app.hostname ||
      app.username || app.password || app.toString() !== appUri) {
    throw new EntrywayError("provider_invalid", "Native SAI link must use canonical HTTPS authorization UI", {
      statusCode: 500,
    });
  }

  return { saiAuthorizationUrl: authorization, saiAppUri: appUri };
}

export function buildNativeSaiAuthorizationUrl(provider: EntrywayProviderDefinition): string | undefined {
  const { saiAuthorizationUrl, saiAppUri } = normalizeNativeSaiConfig(provider);
  if (!saiAuthorizationUrl || !saiAppUri) return undefined;
  const page = new URL(saiAuthorizationUrl);
  page.searchParams.set("client_id", saiAppUri);
  return page.toString();
}

export function normalizeProviderBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new EntrywayError("provider_invalid", "Provider base URL is required", { statusCode: 500 });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new EntrywayError("provider_invalid", "Provider base URL is invalid", {
      statusCode: 500,
      cause: error,
    });
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EntrywayError(
      "provider_invalid",
      "Provider base URL must not include credentials, query, or fragment",
      { statusCode: 500 },
    );
  }

  if (!isSecureOrTrustedInternalUrl(parsed)) {
    throw new EntrywayError(
      "provider_invalid",
      "Provider base URL must use https unless it targets a trusted internal host",
      { statusCode: 500 },
    );
  }

  return parsed.origin;
}

function normalizeBootstrapPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    throw new EntrywayError("provider_invalid", "Provider app bootstrap path must be an absolute path", {
      statusCode: 500,
    });
  }

  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new EntrywayError("provider_invalid", "Provider app bootstrap path must not include query or fragment", {
      statusCode: 500,
    });
  }

  return trimmed;
}
