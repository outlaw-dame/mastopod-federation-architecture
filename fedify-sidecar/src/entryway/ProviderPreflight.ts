import { ActivityPodsProvisioningClient } from "./ActivityPodsProvisioningClient.js";
import { EntrywayError } from "./errors.js";
import type {
  EntrywayBundleCheck,
  EntrywayProtocolSet,
  EntrywayProviderDefinition,
} from "./types.js";

export interface EntrywayProviderPreflight {
  assertProviderReady(
    provider: EntrywayProviderDefinition,
    protocols: EntrywayProtocolSet,
  ): Promise<EntrywayBundleCheck[]>;
}

interface CacheEntry {
  expiresAtMs: number;
  result:
    | { ok: true; checks: EntrywayBundleCheck[] }
    | { ok: false; error: EntrywayError };
}

export class ProviderCapabilitiesPreflight implements EntrywayProviderPreflight {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;

  public constructor(
    private readonly providerClient: ActivityPodsProvisioningClient,
    options: {
      successTtlMs?: number;
      failureTtlMs?: number;
    } = {},
  ) {
    this.successTtlMs = clampInteger(options.successTtlMs ?? 60_000, 0, 10 * 60_000);
    this.failureTtlMs = clampInteger(options.failureTtlMs ?? 10_000, 0, 60_000);
  }

  public async assertProviderReady(
    provider: EntrywayProviderDefinition,
    protocols: EntrywayProtocolSet,
  ): Promise<EntrywayBundleCheck[]> {
    const cacheKey = `${provider.providerId}:${provider.baseUrl}:${protocols.solid}:${protocols.activitypub}:${protocols.atproto}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      if (cached.result.ok) {
        return cached.result.checks;
      }
      throw cached.result.error;
    }

    try {
      const document = await this.providerClient.getProviderCapabilities(provider);
      const checks = validateCapabilitiesDocument(document, protocols);
      this.cache.set(cacheKey, {
        expiresAtMs: Date.now() + this.successTtlMs,
        result: { ok: true, checks },
      });
      return checks;
    } catch (error) {
      const entrywayError = error instanceof EntrywayError
        ? error
        : new EntrywayError("provider_preflight_failed", "Provider preflight failed", {
            statusCode: 502,
            retryable: true,
            cause: error,
          });
      this.cache.set(cacheKey, {
        expiresAtMs: Date.now() + this.failureTtlMs,
        result: { ok: false, error: entrywayError },
      });
      throw entrywayError;
    }
  }
}

function validateCapabilitiesDocument(
  document: Record<string, unknown>,
  protocols: EntrywayProtocolSet,
): EntrywayBundleCheck[] {
  const checks: EntrywayBundleCheck[] = [];
  const checkedAt = new Date().toISOString();

  if (document["schemaVersion"] !== "1.0.0") {
    throw new EntrywayError("provider_capabilities_invalid", "Provider capabilities schema version is unsupported", {
      statusCode: 502,
      retryable: false,
    });
  }
  checks.push({ name: "provider_capabilities_schema", status: "passed", checkedAt });

  const capabilities = Array.isArray(document["capabilities"]) ? document["capabilities"] : [];
  const accountProvisioning = capabilities
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .find((entry) => entry["id"] === "provider.account.provisioning");

  if (!accountProvisioning) {
    throw new EntrywayError("provider_provisioning_capability_missing", "Provider does not advertise account provisioning", {
      statusCode: 502,
      retryable: false,
    });
  }

  const status = accountProvisioning["status"];
  if (status !== "enabled" && status !== "beta") {
    throw new EntrywayError("provider_provisioning_disabled", "Provider account provisioning is not enabled", {
      statusCode: 503,
      retryable: true,
    });
  }
  checks.push({
    name: "provider_account_provisioning_enabled",
    status: status === "beta" ? "warning" : "passed",
    checkedAt,
    message: status === "beta" ? "Provider advertises account provisioning as beta" : undefined,
  });

  const limits = readRecord(accountProvisioning["limits"]);
  if (limits["approvedAppsRequired"] !== true) {
    throw new EntrywayError(
      "provider_approved_apps_not_required",
      "Provider account provisioning must require approved apps",
      { statusCode: 502, retryable: false },
    );
  }
  checks.push({ name: "provider_approved_apps_required", status: "passed", checkedAt });

  if (limits["requiresUserVerification"] !== true) {
    throw new EntrywayError(
      "provider_user_verification_not_required",
      "Provider account provisioning must require user verification",
      { statusCode: 502, retryable: false },
    );
  }
  checks.push({ name: "provider_user_verification_required", status: "passed", checkedAt });

  assertProtocolSupport(document, limits, protocols);
  checks.push({ name: "provider_protocol_bundle_supported", status: "passed", checkedAt });

  const security = readRecord(document["security"]);
  if (security["failClosed"] !== true) {
    throw new EntrywayError("provider_fail_closed_required", "Provider capabilities must advertise failClosed=true", {
      statusCode: 502,
      retryable: false,
    });
  }
  checks.push({ name: "provider_fail_closed", status: "passed", checkedAt });

  return checks;
}

function assertProtocolSupport(
  document: Record<string, unknown>,
  limits: Record<string, unknown>,
  protocols: EntrywayProtocolSet,
): void {
  const supportedProtocolSet = typeof limits["supportedProtocolSet"] === "string"
    ? new Set(limits["supportedProtocolSet"].split(",").map((value) => value.trim()).filter(Boolean))
    : null;

  for (const protocol of ["solid", "activitypub", "atproto"] as const) {
    if (!protocols[protocol]) {
      continue;
    }

    if (supportedProtocolSet && !supportedProtocolSet.has(protocol)) {
      throw new EntrywayError(
        "provider_protocol_unsupported",
        `Provider does not support requested ${protocol} provisioning`,
        { statusCode: 400, retryable: false },
      );
    }
  }

  const protocolStatus = readRecord(document["protocols"]);
  const activitypub = readRecord(protocolStatus["activitypub"]);
  const atproto = readRecord(protocolStatus["atproto"]);

  if (protocols.activitypub && activitypub["enabled"] === false) {
    throw new EntrywayError("provider_protocol_unsupported", "Provider ActivityPub protocol is disabled", {
      statusCode: 400,
      retryable: false,
    });
  }

  if (protocols.atproto && atproto["enabled"] !== true) {
    throw new EntrywayError("provider_protocol_unsupported", "Provider ATProto protocol is disabled", {
      statusCode: 400,
      retryable: false,
    });
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
