/**
 * Entitlement module — plan-to-capability limits and per-request enforcement.
 *
 * A "plan" is the provider's subscription tier.  Each plan defines a set of
 * numeric limits that are applied consistently across HTTP paths, workers, and
 * stream subscriptions.  Tenant-level overrides (from
 * ProviderCapabilitiesDocument.entitlements.overrides) are applied on top.
 *
 * Principles:
 *  - All comparisons are numeric; unknown fields default to MAX_SAFE_INTEGER
 *    (allow).
 *  - Overrides cannot raise a limit above the next plan's ceiling—callers are
 *    responsible for that business rule if needed; this module applies them
 *    as-is.
 *  - No external I/O.  Pure functions only.
 *  - Unknown plan names are silently normalised to "standard".
 */

import type { EntitlementOverride } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PlanName = "basic" | "standard" | "pro" | "enterprise";

export type EntitlementLimits = Readonly<Record<string, number | string | boolean>>;

export interface EntitlementCheckResult {
  allowed: boolean;
  capabilityId: string;
  limitField: string;
  /** Effective numeric limit that was compared against. */
  effectiveLimit: number;
  /** Value presented for comparison. */
  actualValue: number;
  reasonCode: "allowed" | "limit_exceeded";
}

// ---------------------------------------------------------------------------
// Base plan limits
// ---------------------------------------------------------------------------

type PlanLimitsMap = Record<PlanName, Record<string, EntitlementLimits>>;

/**
 * Authoritative plan-to-capability limits table.
 * All numeric values are the *maximum* permitted value for that field.
 */
const PLAN_LIMITS: PlanLimitsMap = {
  basic: {
    "provider.account.provisioning": { maxAccountsPerAppPerDay: 25 },
    "ap.federation.ingress": { requestsPerMinute: 600 },
    "ap.federation.egress": { maxConcurrentPerDomain: 2, maxAttempts: 5 },
    "ap.signing.batch": { batchSize: 50, timeoutMs: 5_000 },
    "ap.feeds.realtime": { maxSseConnections: 10, maxWsConnections: 5, maxStreamsPerConnection: 2 },
    "ap.streams": { retentionDays: 7, replayWindowHours: 24 },
    "ap.search.opensearch": { queryTimeoutMs: 5_000 },
    "at.xrpc.server": { requestsPerMinute: 300 },
    "at.xrpc.repo": { maxWritesPerMinute: 120 },
  },
  standard: {
    "provider.account.provisioning": { maxAccountsPerAppPerDay: 100 },
    "ap.federation.ingress": { requestsPerMinute: 1_200 },
    "ap.federation.egress": { maxConcurrentPerDomain: 4, maxAttempts: 8 },
    "ap.signing.batch": { batchSize: 100, timeoutMs: 5_000 },
    "ap.feeds.realtime": { maxSseConnections: 50, maxWsConnections: 25, maxStreamsPerConnection: 4 },
    "ap.streams": { retentionDays: 14, replayWindowHours: 48 },
    "ap.search.opensearch": { queryTimeoutMs: 3_000 },
    "at.xrpc.server": { requestsPerMinute: 600 },
    "at.xrpc.repo": { maxWritesPerMinute: 300 },
  },
  pro: {
    "provider.account.provisioning": { maxAccountsPerAppPerDay: 250 },
    "ap.federation.ingress": { requestsPerMinute: 3_000 },
    "ap.federation.egress": { maxConcurrentPerDomain: 8, maxAttempts: 10 },
    "ap.signing.batch": { batchSize: 200, timeoutMs: 5_000 },
    "ap.feeds.realtime": { maxSseConnections: 200, maxWsConnections: 100, maxStreamsPerConnection: 6 },
    "ap.streams": { retentionDays: 30, replayWindowHours: 72 },
    "ap.search.opensearch": { queryTimeoutMs: 3_000 },
    "at.xrpc.server": { requestsPerMinute: 1_200 },
    "at.xrpc.repo": { maxWritesPerMinute: 600 },
  },
  enterprise: {
    "provider.account.provisioning": { maxAccountsPerAppPerDay: 1_000 },
    "ap.federation.ingress": { requestsPerMinute: 10_000 },
    "ap.federation.egress": { maxConcurrentPerDomain: 20, maxAttempts: 12 },
    "ap.signing.batch": { batchSize: 500, timeoutMs: 5_000 },
    "ap.feeds.realtime": { maxSseConnections: 1_000, maxWsConnections: 500, maxStreamsPerConnection: 10 },
    "ap.streams": { retentionDays: 90, replayWindowHours: 168 },
    "ap.search.opensearch": { queryTimeoutMs: 3_000 },
    "at.xrpc.server": { requestsPerMinute: 5_000 },
    "at.xrpc.repo": { maxWritesPerMinute: 2_500 },
  },
} as const satisfies PlanLimitsMap;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePlan(plan: string): PlanName {
  if (plan === "basic" || plan === "standard" || plan === "pro" || plan === "enterprise") {
    return plan;
  }
  return "standard";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the effective limits for a capability after applying tenant overrides.
 * Returns a plain record of field → value.  Missing fields default to
 * Number.MAX_SAFE_INTEGER when checked numerically.
 */
export function resolveEffectiveLimits(
  plan: string,
  capabilityId: string,
  overrides: ReadonlyArray<EntitlementOverride>,
): Record<string, number | string | boolean> {
  const basePlan = normalizePlan(plan);
  const base: Record<string, number | string | boolean> = {
    ...(PLAN_LIMITS[basePlan][capabilityId] ?? {}),
  };

  for (const override of overrides) {
    if (override.capabilityId !== capabilityId) continue;
    if (override.type === "limit") {
      base[override.field] = override.value;
    }
  }

  return base;
}

/**
 * Check whether `actualValue` is within the effective limit for
 * `limitField` on `capabilityId` for the given `plan` + `overrides`.
 *
 * Returns an {@link EntitlementCheckResult} describing whether the check
 * passed and what limit was applied.
 */
export function checkCapabilityLimit(
  plan: string,
  capabilityId: string,
  limitField: string,
  actualValue: number,
  overrides: ReadonlyArray<EntitlementOverride>,
): EntitlementCheckResult {
  const limits = resolveEffectiveLimits(plan, capabilityId, overrides);
  const raw = limits[limitField];
  const effectiveLimit =
    typeof raw === "number" ? raw : Number.MAX_SAFE_INTEGER;

  if (actualValue > effectiveLimit) {
    return {
      allowed: false,
      capabilityId,
      limitField,
      effectiveLimit,
      actualValue,
      reasonCode: "limit_exceeded",
    };
  }

  return {
    allowed: true,
    capabilityId,
    limitField,
    effectiveLimit,
    actualValue,
    reasonCode: "allowed",
  };
}

/**
 * Parse tenant-level entitlement overrides from the `ENTITLEMENT_OVERRIDES`
 * environment variable (JSON array of {@link EntitlementOverride} objects).
 *
 * Returns an empty array on any parse failure — never throws.
 */
export function buildEntitlementOverridesFromEnv(
  env: NodeJS.ProcessEnv,
): EntitlementOverride[] {
  const raw = env["ENTITLEMENT_OVERRIDES"];
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item): item is EntitlementOverride =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>)["capabilityId"] === "string" &&
      typeof (item as Record<string, unknown>)["type"] === "string" &&
      typeof (item as Record<string, unknown>)["field"] === "string" &&
      (item as Record<string, unknown>)["value"] !== undefined,
  );
}
