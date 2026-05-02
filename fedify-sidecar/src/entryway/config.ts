import { EntrywayError } from "./errors.js";
import type { EntrywayProviderDefinition } from "./types.js";

export interface EntrywayProviderEnvFallbacks {
  activityPodsUrl?: string;
  activityPodsToken?: string;
  appClientId?: string;
  origin?: string;
  redirectUri?: string;
}

export function buildEntrywayProvidersFromEnv(
  env: NodeJS.ProcessEnv,
  fallbacks: EntrywayProviderEnvFallbacks = {},
): EntrywayProviderDefinition[] {
  const rawJson = env["ENTRYWAY_PROVIDERS_JSON"]?.trim();
  if (rawJson) {
    return parseProvidersJson(rawJson);
  }

  const baseUrl = env["ENTRYWAY_DEFAULT_PROVIDER_URL"] || fallbacks.activityPodsUrl;
  const provisioningBearerToken =
    env["ENTRYWAY_PROVIDER_PROVISIONING_TOKEN"] || fallbacks.activityPodsToken;
  const appClientId = env["ENTRYWAY_APP_CLIENT_ID"] || fallbacks.appClientId;

  if (!baseUrl && !provisioningBearerToken && !appClientId) {
    return [];
  }

  if (!baseUrl || !provisioningBearerToken || !appClientId) {
    throw new EntrywayError(
      "entryway_provider_config_incomplete",
      "Entryway provider config requires provider URL, provisioning token, and app client id",
      { statusCode: 500 },
    );
  }

  return [
    {
      providerId: env["ENTRYWAY_DEFAULT_PROVIDER_ID"] || "default",
      baseUrl,
      provisioningBearerToken,
      appClientId,
      origin: env["ENTRYWAY_APP_ORIGIN"] || fallbacks.origin,
      redirectUri: env["ENTRYWAY_REDIRECT_URI"] || fallbacks.redirectUri,
      enabled: env["ENTRYWAY_DEFAULT_PROVIDER_ENABLED"] !== "false",
      appBootstrapPath: env["ENTRYWAY_APP_BOOTSTRAP_PATH"] || undefined,
      appBootstrapEnabled: env["ENTRYWAY_APP_BOOTSTRAP_ENABLED"] === "true",
    },
  ];
}

function parseProvidersJson(rawJson: string): EntrywayProviderDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (error) {
    throw new EntrywayError("entryway_provider_config_invalid", "ENTRYWAY_PROVIDERS_JSON is not valid JSON", {
      statusCode: 500,
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new EntrywayError("entryway_provider_config_invalid", "ENTRYWAY_PROVIDERS_JSON must be an array", {
      statusCode: 500,
    });
  }

  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EntrywayError("entryway_provider_config_invalid", "Entryway provider entry must be an object", {
        statusCode: 500,
      });
    }

    const record = entry as Record<string, unknown>;
    return {
      providerId: readRequiredString(record, "providerId"),
      baseUrl: readRequiredString(record, "baseUrl"),
      provisioningBearerToken: readRequiredString(record, "provisioningBearerToken"),
      appClientId: readRequiredString(record, "appClientId"),
      origin: readOptionalString(record, "origin"),
      redirectUri: readOptionalString(record, "redirectUri"),
      enabled: record["enabled"] !== false,
      appBootstrapPath: readOptionalString(record, "appBootstrapPath"),
      appBootstrapEnabled: record["appBootstrapEnabled"] === true,
    };
  });
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new EntrywayError("entryway_provider_config_invalid", `Entryway provider ${key} is required`, {
      statusCode: 500,
    });
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
