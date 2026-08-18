import { isIP } from "node:net";

const APDM_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1";
const APDM_INTEROP_LEGACY_INTENT_ID = "apdm-interop-legacy-fixture";
const APDM_OBSERVATION_INTENT_PREFIX = "apdm-observation:";
const SIDECAR_INTERNAL_INTENT_PREFIXES = [APDM_OBSERVATION_INTENT_PREFIX, "moderation-report:"] as const;
const EXPLICIT_NON_PRODUCTION_ENVIRONMENTS = new Set(["test", "development"]);

type ApdmAuthoritySource = "delivery_plan" | "interop_legacy";

export interface NormalizedOutboundTarget {
  inboxUrl: string;
  sharedInboxUrl?: string;
  deliveryUrl: string;
  targetDomain: string;
}

export interface NormalizedOutboundTargetsResult {
  targets: NormalizedOutboundTarget[];
  inputTargetCount: number;
  duplicateTargetCount: number;
  invalidTargetCount: number;
  /** Present only while normalizing raw ActivityPods webhook targets. */
  apdmAuthorityIntentId?: string;
  /** Provenance for the accepted raw-boundary authority. Never inferred from the intent ID itself. */
  apdmAuthoritySource?: ApdmAuthoritySource;
}

export interface OutboundWebhookBackpressureConfig {
  maxPending: number;
  maxQueueDepth: number;
  retryAfterSeconds: number;
  maxTargetsPerRequest: number;
}

type OutboundTargetNormalizationConfig = Pick<OutboundWebhookBackpressureConfig, "maxTargetsPerRequest"> &
  Partial<Pick<OutboundWebhookBackpressureConfig, "maxPending" | "maxQueueDepth" | "retryAfterSeconds">>;

export interface OutboundWebhookQueueSnapshot {
  pendingCount: number;
  streamLength: number;
}

export interface OutboundWebhookBackpressureResult {
  reject: boolean;
  reason?: "pending" | "queue_depth";
  retryAfterSeconds?: number;
}

export class OutboundWebhookValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "OutboundWebhookValidationError";
  }
}

export function normalizeAndDedupeOutboundTargets(
  remoteTargets: unknown,
  config: OutboundTargetNormalizationConfig,
): NormalizedOutboundTargetsResult {
  if (!Array.isArray(remoteTargets)) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_TARGETS_INVALID",
      400,
      "remoteTargets must be an array.",
    );
  }

  // An authoritative ActivityPods Delivery Plan may legitimately contain zero
  // remote recipients. Stream1 observation is provider-wide and must not depend
  // on whether federation fan-out happens to be necessary for this activity.
  // The Delivery Plan identity is validated separately from the target list.
  if (remoteTargets.length > config.maxTargetsPerRequest) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_TARGETS_TOO_LARGE",
      413,
      `remoteTargets exceeds the configured maximum of ${config.maxTargetsPerRequest}.`,
    );
  }

  const requireApdmAuthority = isWebhookBoundaryConfig(config);

  let apdmAuthorityIntentId: string | undefined;
  let apdmAuthoritySource: ApdmAuthoritySource | undefined;
  if (requireApdmAuthority) {
    for (const rawTarget of remoteTargets) {
      const authority = parseApdmAuthority(rawTarget) ?? parseExplicitInteropAuthority(rawTarget);
      if (!authority) {
        throw new OutboundWebhookValidationError(
          "OUTBOUND_APDM_AUTHORITY_REQUIRED",
          400,
          "Every raw remote target must carry an ap.delivery-plan.v1 APDM authority marker.",
        );
      }
      if (apdmAuthorityIntentId === undefined) {
        apdmAuthorityIntentId = authority.intentId;
        apdmAuthoritySource = authority.source;
      } else if (
        authority.intentId !== apdmAuthorityIntentId ||
        authority.source !== apdmAuthoritySource
      ) {
        throw new OutboundWebhookValidationError(
          "OUTBOUND_APDM_AUTHORITY_MIXED",
          400,
          "All raw remote targets in one handoff must carry the same APDM Delivery Plan authority.",
        );
      }
    }
  }

  const deduped = new Map<string, NormalizedOutboundTarget>();
  let invalidTargetCount = 0;
  let duplicateTargetCount = 0;

  for (const rawTarget of remoteTargets) {
    const normalized = normalizeOutboundTarget(rawTarget);
    if (!normalized) {
      invalidTargetCount++;
      continue;
    }

    if (deduped.has(normalized.deliveryUrl)) {
      duplicateTargetCount++;
      continue;
    }

    deduped.set(normalized.deliveryUrl, normalized);
  }

  const targets = [...deduped.values()];
  if (remoteTargets.length > 0 && targets.length === 0) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_TARGETS_UNUSABLE",
      400,
      "remoteTargets did not contain any valid delivery targets.",
    );
  }

  return {
    targets,
    inputTargetCount: remoteTargets.length,
    duplicateTargetCount,
    invalidTargetCount,
    ...(apdmAuthorityIntentId ? { apdmAuthorityIntentId } : {}),
    ...(apdmAuthoritySource ? { apdmAuthoritySource } : {}),
  };
}

/**
 * Bind the authoritative APDM handoff identity to its Delivery Plan metadata.
 * Non-empty target sets additionally bind every target marker to that same
 * identity. Zero-target plans have no target on which to carry the marker, so
 * their authority is established by the authenticated boundary plus matching
 * X-APDM-Intent-Id and ap.delivery-plan.v1 metadata.
 *
 * Returns the stable Delivery Plan intent ID for production handoffs. The only
 * undefined result is an exception whose provenance was established by the
 * explicit non-production interop allowlist during target normalization.
 */
export function validateApdmWebhookIdentity(input: {
  normalizedTargets: NormalizedOutboundTargetsResult;
  headerIntentId: unknown;
  meta: unknown;
}): string | undefined {
  const markerIntentId = input.normalizedTargets.apdmAuthorityIntentId;
  const authoritySource = input.normalizedTargets.apdmAuthoritySource;

  // Preserve the explicit test/development-only interop exception exactly as
  // before. It is provenance-gated by target normalization and never applies to
  // production Delivery Plans or to zero-target handoffs.
  if (authoritySource === "interop_legacy") {
    return undefined;
  }

  const headerIntentId = normalizeExactIntentId(input.headerIntentId);
  if (!headerIntentId) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_INTENT_HEADER_REQUIRED",
      400,
      "X-APDM-Intent-Id must contain the authoritative Delivery Plan intentId.",
    );
  }

  if (!input.meta || typeof input.meta !== "object" || Array.isArray(input.meta)) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_META_REQUIRED",
      400,
      "APDM Delivery Plan metadata is required.",
    );
  }

  const meta = input.meta as Record<string, unknown>;
  if (meta["deliveryPlanSchema"] !== APDM_DELIVERY_PLAN_SCHEMA) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_SCHEMA_MISMATCH",
      400,
      "meta.deliveryPlanSchema must be ap.delivery-plan.v1.",
    );
  }

  const metaIntentId = normalizeExactIntentId(meta["deliveryPlanIntentId"]);
  if (!metaIntentId) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_META_INTENT_REQUIRED",
      400,
      "meta.deliveryPlanIntentId must contain the authoritative Delivery Plan intentId.",
    );
  }

  if (SIDECAR_INTERNAL_INTENT_PREFIXES.some((prefix) => headerIntentId.startsWith(prefix))) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_INTENT_RESERVED",
      400,
      "Delivery Plan intentId must not use a sidecar-reserved durable intent namespace.",
    );
  }

  if (input.normalizedTargets.inputTargetCount === 0) {
    if (metaIntentId !== headerIntentId) {
      throw new OutboundWebhookValidationError(
        "OUTBOUND_APDM_INTENT_MISMATCH",
        400,
        "X-APDM-Intent-Id and meta.deliveryPlanIntentId must match for a zero-target Delivery Plan.",
      );
    }
    return headerIntentId;
  }

  if (!markerIntentId || !authoritySource) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_AUTHORITY_REQUIRED",
      400,
      "APDM Delivery Plan target authority is required.",
    );
  }

  if (SIDECAR_INTERNAL_INTENT_PREFIXES.some((prefix) => markerIntentId.startsWith(prefix))) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_INTENT_RESERVED",
      400,
      "Delivery Plan intentId must not use a sidecar-reserved durable intent namespace.",
    );
  }

  if (headerIntentId !== markerIntentId || metaIntentId !== markerIntentId) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_APDM_INTENT_MISMATCH",
      400,
      "APDM target marker, X-APDM-Intent-Id, and meta.deliveryPlanIntentId must match.",
    );
  }

  return markerIntentId;
}

export function evaluateOutboundWebhookBackpressure(
  snapshot: OutboundWebhookQueueSnapshot,
  config: OutboundWebhookBackpressureConfig,
): OutboundWebhookBackpressureResult {
  if (config.maxPending > 0 && snapshot.pendingCount >= config.maxPending) {
    return {
      reject: true,
      reason: "pending",
      retryAfterSeconds: config.retryAfterSeconds,
    };
  }

  if (
    config.maxQueueDepth > 0 &&
    snapshot.pendingCount > 0 &&
    snapshot.streamLength >= config.maxQueueDepth
  ) {
    return {
      reject: true,
      reason: "queue_depth",
      retryAfterSeconds: config.retryAfterSeconds,
    };
  }

  return { reject: false };
}

export function resolveOutboundWebhookBackpressureConfigFromEnv(): OutboundWebhookBackpressureConfig {
  return {
    maxPending: parsePositiveIntEnv("OUTBOUND_WEBHOOK_MAX_PENDING", 25_000),
    maxQueueDepth: parseNonNegativeIntEnv("OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH", 0),
    retryAfterSeconds: parsePositiveIntEnv("OUTBOUND_WEBHOOK_RETRY_AFTER_SECONDS", 5),
    maxTargetsPerRequest: parsePositiveIntEnv("OUTBOUND_WEBHOOK_MAX_TARGETS", 5_000),
  };
}

function isWebhookBoundaryConfig(config: OutboundTargetNormalizationConfig): boolean {
  return (
    typeof config.maxPending === "number" &&
    typeof config.maxQueueDepth === "number" &&
    typeof config.retryAfterSeconds === "number"
  );
}

function parseApdmAuthority(rawTarget: unknown): { intentId: string; source: ApdmAuthoritySource } | null {
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) return null;
  const authority = (rawTarget as Record<string, unknown>)["apdmAuthority"];
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) return null;
  const record = authority as Record<string, unknown>;
  if (record["schema"] !== APDM_DELIVERY_PLAN_SCHEMA) return null;
  const intentId = normalizeExactIntentId(record["intentId"]);
  return intentId ? { intentId, source: "delivery_plan" } : null;
}

function parseExplicitInteropAuthority(rawTarget: unknown): { intentId: string; source: ApdmAuthoritySource } | null {
  const environment = String(process.env["NODE_ENV"] ?? "").trim().toLowerCase();
  if (!EXPLICIT_NON_PRODUCTION_ENVIRONMENTS.has(environment)) return null;
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) return null;

  const target = rawTarget as Record<string, unknown>;
  const sharedInboxUrl = normalizeFederationTargetUrl(target["sharedInboxUrl"]);
  const inboxUrl = normalizeFederationTargetUrl(target["inboxUrl"]);
  const deliveryUrl = sharedInboxUrl ?? inboxUrl;
  if (!deliveryUrl) return null;

  const hostname = new URL(deliveryUrl).hostname.toLowerCase();

  const allowedHosts = new Set(
    String(process.env["APDM_INTEROP_PRIVATE_HOSTS"] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowedHosts.has(hostname)) return null;

  return { intentId: APDM_INTEROP_LEGACY_INTENT_ID, source: "interop_legacy" };
}

function normalizeExactIntentId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) return null;
  return value;
}

function normalizeOutboundTarget(rawTarget: unknown): NormalizedOutboundTarget | null {
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) return null;
  const target = rawTarget as Record<string, unknown>;
  const inboxUrl = normalizeFederationTargetUrl(target["inboxUrl"]);
  if (!inboxUrl) return null;
  const sharedInboxUrl = normalizeFederationTargetUrl(target["sharedInboxUrl"]);
  const deliveryUrl = sharedInboxUrl ?? inboxUrl;
  const targetDomain = new URL(deliveryUrl).hostname.toLowerCase();
  return {
    inboxUrl,
    ...(sharedInboxUrl ? { sharedInboxUrl } : {}),
    deliveryUrl,
    targetDomain,
  };
}

function normalizeFederationTargetUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (protocol !== "https:" && !(protocol === "http:" && isLoopbackHost(hostname))) return null;
  parsed.hash = "";
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return hostname.startsWith("127.");
  return false;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
