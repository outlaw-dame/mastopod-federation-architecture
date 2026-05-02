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

  return {
    ...provider,
    providerId,
    baseUrl: normalizeProviderBaseUrl(provider.baseUrl),
    appClientId: provider.appClientId.trim(),
    provisioningBearerToken: provider.provisioningBearerToken.trim(),
    origin: provider.origin?.trim() || undefined,
    redirectUri: provider.redirectUri?.trim() || undefined,
    enabled: provider.enabled !== false,
    appBootstrapPath: normalizeBootstrapPath(provider.appBootstrapPath),
    appBootstrapEnabled: provider.appBootstrapEnabled === true,
  };
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
