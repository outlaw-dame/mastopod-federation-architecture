import { isIP } from "node:net";

const APDM_DELIVERY_PLAN_SCHEMA = "ap.delivery-plan.v1";

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
  /** Stable ActivityPods Delivery Plan identity proven by every input target. */
  apdmAuthorityIntentId: string;
}

export interface OutboundWebhookBackpressureConfig {
  maxPending: number;
  maxQueueDepth: number;
  retryAfterSeconds: number;
  maxTargetsPerRequest: number;
}

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
  config: Pick<OutboundWebhookBackpressureConfig, "maxTargetsPerRequest">,
): NormalizedOutboundTargetsResult {
  if (!Array.isArray(remoteTargets)) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_TARGETS_INVALID",
      400,
      "remoteTargets must be an array.",
    );
  }

  if (remoteTargets.length === 0) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_TARGETS_EMPTY",
      400,
      "remoteTargets must contain at least one delivery target.",
    );
  }

  if (remoteTargets.length > config.maxTargetsPerRequest) {
    throw new OutboundWebhookValidationError(
      "OUTBOUND_TARGETS_TOO_LARGE",
      413,
      `remoteTargets exceeds the configured maximum of ${config.maxTargetsPerRequest}.`,
    );
  }

  // APDM Phase 6 retires the legacy raw-activity webhook as a routing
  // authority. Every target accepted from ActivityPods must now prove that it
  // came from one stable ap.delivery-plan.v1 intent. Validate this before URL
  // filtering/dedupe so a mixed request cannot smuggle an unmarked target in
  // as a merely "invalid" entry while another marked target keeps it accepted.
  let apdmAuthorityIntentId: string | undefined;
  for (const rawTarget of remoteTargets) {
    const authority = parseApdmAuthority(rawTarget);
    if (!authority) {
      throw new OutboundWebhookValidationError(
        "OUTBOUND_APDM_AUTHORITY_REQUIRED",
        400,
        "Every remote target must carry an ap.delivery-plan.v1 APDM authority marker.",
      );
    }
    if (apdmAuthorityIntentId === undefined) {
      apdmAuthorityIntentId = authority.intentId;
    } else if (authority.intentId !== apdmAuthorityIntentId) {
      throw new OutboundWebhookValidationError(
        "OUTBOUND_APDM_AUTHORITY_MIXED",
        400,
        "All remote targets in one handoff must carry the same APDM Delivery Plan intentId.",
      );
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
  if (targets.length === 0) {
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
    apdmAuthorityIntentId: apdmAuthorityIntentId!,
  };
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

  // Redis stream length is historical and can stay high even after workers
  // drain current load. Treat queue-depth backpressure as actionable only when
  // there is active pending work to avoid permanent false-positive rejection.
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
    // Stream length is historical, not just active backlog. Keep disabled by
    // default to avoid false positives after long-running benchmarks.
    maxQueueDepth: parseNonNegativeIntEnv("OUTBOUND_WEBHOOK_MAX_QUEUE_DEPTH", 0),
    retryAfterSeconds: parsePositiveIntEnv("OUTBOUND_WEBHOOK_RETRY_AFTER_SECONDS", 5),
    maxTargetsPerRequest: parsePositiveIntEnv("OUTBOUND_WEBHOOK_MAX_TARGETS", 5_000),
  };
}

function parseApdmAuthority(rawTarget: unknown): { intentId: string } | null {
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
    return null;
  }

  const authority = (rawTarget as Record<string, unknown>)["apdmAuthority"];
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    return null;
  }

  const record = authority as Record<string, unknown>;
  if (record["schema"] !== APDM_DELIVERY_PLAN_SCHEMA) {
    return null;
  }

  const intentId = record["intentId"];
  if (typeof intentId !== "string" || intentId.trim().length === 0 || intentId !== intentId.trim()) {
    return null;
  }

  return { intentId };
}

function normalizeOutboundTarget(rawTarget: unknown): NormalizedOutboundTarget | null {
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
    return null;
  }

  const target = rawTarget as Record<string, unknown>;
  const inboxUrl = normalizeFederationTargetUrl(target["inboxUrl"]);
  if (!inboxUrl) {
    return null;
  }

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
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (protocol !== "https:" && !(protocol === "http:" && isLoopbackHost(hostname))) {
    return null;
  }

  parsed.hash = "";
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return hostname.startsWith("127.");
  }

  return false;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
