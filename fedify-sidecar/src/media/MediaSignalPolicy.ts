import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFDecisionTrace, MRFMode } from "../admin/mrf/types.js";
import {
  mediaPolicyRegistration,
  type MediaPolicyConfig,
} from "../admin/mrf/registry/modules/media-policy.js";

export interface MediaSignalPolicyInput {
  activityId: string;
  originHost?: string;
  actorId?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
  signals: unknown;
}

export interface MediaPolicyDecision {
  moduleId: "media-policy";
  traceId: string;
  mode: MRFMode;
  desiredAction: "accept" | "label" | "filter" | "reject";
  appliedAction: "accept" | "label" | "filter" | "reject";
  matchedLabels: string[];
  matchedSources: string[];
  confidence?: number;
  reason?: string;
  markSensitive: boolean;
  contentWarning?: string;
}

interface NormalizedSignal {
  source: string;
  labels: string[];
  confidence?: number;
}

function normalizeSignals(raw: unknown): NormalizedSignal[] {
  if (!Array.isArray(raw)) return [];

  const normalized: NormalizedSignal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = typeof item.source === "string" ? item.source.trim().toLowerCase() : "";
    if (!source) continue;

    const rawLabels = Array.isArray(item.labels) ? item.labels : [];
    const labels = Array.isArray(rawLabels)
      ? [...new Set(rawLabels
        .filter((label: unknown): label is string => typeof label === "string")
        .map((label: string) => label.trim().toLowerCase())
        .filter(Boolean))]
      : [];

    const signal: NormalizedSignal = { source, labels };
    if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
      signal.confidence = Math.max(0, Math.min(1, item.confidence));
    }
    normalized.push(signal);
  }

  return normalized;
}

function filterSignalsBySource(signals: NormalizedSignal[], trustedSources: string[]): NormalizedSignal[] {
  if (trustedSources.length === 0) return signals;
  const allowed = new Set(trustedSources);
  return signals.filter((signal) => allowed.has(signal.source));
}

function pickMatch(
  signals: NormalizedSignal[],
  labels: string[],
  minConfidence: number,
): { labels: string[]; sources: string[]; confidence?: number } {
  const wanted = new Set(labels);
  const matchedLabels = new Set<string>();
  const matchedSources = new Set<string>();
  let confidence: number | undefined;

  for (const signal of signals) {
    const signalConfidence = signal.confidence ?? 1;
    if (signalConfidence < minConfidence) continue;

    const intersecting = signal.labels.filter((label) => wanted.has(label));
    if (intersecting.length === 0) continue;

    intersecting.forEach((label) => matchedLabels.add(label));
    matchedSources.add(signal.source);
    confidence = confidence === undefined ? signalConfidence : Math.max(confidence, signalConfidence);
  }

  return {
    labels: [...matchedLabels],
    sources: [...matchedSources],
    confidence,
  };
}

async function appendTrace(store: MRFAdminStore, trace: MRFDecisionTrace): Promise<void> {
  await store.appendTrace(trace);
}

export async function evaluateMediaSignalPolicy(
  store: MRFAdminStore | null,
  input: MediaSignalPolicyInput,
  options?: {
    now?: () => string;
    requestId?: string;
  },
): Promise<MediaPolicyDecision | null> {
  if (!store) return null;

  const moduleConfig = await store.getModuleConfig("media-policy");
  if (!moduleConfig || !moduleConfig.enabled) {
    return null;
  }

  const parsed = mediaPolicyRegistration.validateAndNormalizeConfig(moduleConfig.config, {
    existingConfig: mediaPolicyRegistration.getDefaultConfig(),
    partial: true,
  });
  const config = parsed.config as MediaPolicyConfig;
  const now = options?.now ?? (() => new Date().toISOString());
  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const signals = filterSignalsBySource(normalizeSignals(input.signals), config.trustedSources);

  const blocked = pickMatch(signals, config.blockedLabels, config.minBlockedConfidence);
  const sensitive = pickMatch(signals, config.sensitiveLabels, config.minSensitiveConfidence);

  let desiredAction: "accept" | "label" | "filter" | "reject" = "accept";
  let matchedLabels: string[] = [];
  let matchedSources: string[] = [];
  let confidence: number | undefined;
  let reason: string | undefined;

  if (blocked.labels.length > 0) {
    desiredAction = config.blockedAction;
    matchedLabels = blocked.labels;
    matchedSources = blocked.sources;
    confidence = blocked.confidence;
    reason = `Blocked media labels matched: ${blocked.labels.join(", ")}`;
  } else if (sensitive.labels.length > 0) {
    desiredAction = "label";
    matchedLabels = sensitive.labels;
    matchedSources = sensitive.sources;
    confidence = sensitive.confidence;
    reason = `Sensitive media labels matched: ${sensitive.labels.join(", ")}`;
  }

  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";
  const markSensitive = appliedAction !== "accept" && config.applySensitiveFlag;
  const contentWarning = appliedAction !== "accept" && config.setContentWarning
    ? config.contentWarningText
    : undefined;

  await appendTrace(store, {
    traceId,
    requestId,
    activityId: input.activityId,
    actorId: input.actorId,
    originHost: input.originHost,
    visibility: input.visibility,
    moduleId: "media-policy",
    mode: moduleConfig.mode,
    action: desiredAction,
    confidence,
    labels: matchedLabels,
    reason: config.traceReasons ? reason : undefined,
    createdAt: now(),
    redacted: false,
  });

  return {
    moduleId: "media-policy",
    traceId,
    mode: moduleConfig.mode,
    desiredAction,
    appliedAction,
    matchedLabels,
    matchedSources,
    confidence,
    reason: config.traceReasons ? reason : undefined,
    markSensitive,
    contentWarning,
  };
}