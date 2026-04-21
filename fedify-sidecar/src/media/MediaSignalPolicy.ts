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
  raw?: unknown;
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
    if ("raw" in item) {
      signal.raw = item.raw;
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

const PDQ_SIGNAL_SOURCE = "pdq-hash";
const PDQ_MATCH_LABEL = "pdq-blocked-image";

function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      distance += 1;
    }
  }
  return distance;
}

function normalizePdqHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/\s+/g, "").toLowerCase();
  if (/^[01]{256}$/.test(normalized)) {
    return normalized;
  }

  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return normalized
      .split("")
      .map((char) => Number.parseInt(char, 16).toString(2).padStart(4, "0"))
      .join("");
  }

  return null;
}

function extractPdqPayload(signal: NormalizedSignal): { hash: string; quality: number } | null {
  if (signal.source !== PDQ_SIGNAL_SOURCE || !signal.raw || typeof signal.raw !== "object" || Array.isArray(signal.raw)) {
    return null;
  }

  const record = signal.raw as Record<string, unknown>;
  const hash = normalizePdqHash(record["pdqHashBinary"] ?? record["pdq_hash_binary"] ?? record["hashBinary"]);
  const quality = record["quality"];
  if (!hash || typeof quality !== "number" || !Number.isFinite(quality)) {
    return null;
  }

  return {
    hash,
    quality: Math.max(0, Math.min(100, Math.trunc(quality))),
  };
}

function pickPdqMatch(
  signals: NormalizedSignal[],
  blockedHashes: string[],
  minQuality: number,
  threshold: number,
): {
  matched: boolean;
  sources: string[];
  confidence?: number;
  bestDistance?: number;
  quality?: number;
  matchedHash?: string;
} {
  if (blockedHashes.length === 0) {
    return { matched: false, sources: [] };
  }

  let best:
    | {
        distance: number;
        quality: number;
        matchedHash: string;
      }
    | undefined;

  for (const signal of signals) {
    const payload = extractPdqPayload(signal);
    if (!payload || payload.quality < minQuality) {
      continue;
    }

    for (const blockedHash of blockedHashes) {
      const distance = hammingDistance(payload.hash, blockedHash);
      if (distance >= threshold) {
        continue;
      }

      if (!best || distance < best.distance || (distance === best.distance && payload.quality > best.quality)) {
        best = {
          distance,
          quality: payload.quality,
          matchedHash: blockedHash,
        };
      }
    }
  }

  if (!best) {
    return { matched: false, sources: [] };
  }

  return {
    matched: true,
    sources: [PDQ_SIGNAL_SOURCE],
    confidence: best.quality / 100,
    bestDistance: best.distance,
    quality: best.quality,
    matchedHash: best.matchedHash,
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
  const pdq = pickPdqMatch(
    signals,
    config.blockedPdqHashes,
    config.minPdqQuality,
    config.pdqHammingThreshold,
  );

  let desiredAction: "accept" | "label" | "filter" | "reject" = "accept";
  let matchedLabels: string[] = [];
  let matchedSources: string[] = [];
  let confidence: number | undefined;
  let reason: string | undefined;

  if (blocked.labels.length > 0 || pdq.matched) {
    desiredAction = config.blockedAction;
    matchedLabels = pdq.matched
      ? [...new Set([...blocked.labels, PDQ_MATCH_LABEL])]
      : blocked.labels;
    matchedSources = [...new Set([...blocked.sources, ...pdq.sources])];
    confidence = Math.max(blocked.confidence ?? 0, pdq.confidence ?? 0) || undefined;

    const reasonParts: string[] = [];
    if (blocked.labels.length > 0) {
      reasonParts.push(`Blocked media labels matched: ${blocked.labels.join(", ")}`);
    }
    if (pdq.matched) {
      reasonParts.push(
        `Blocked image PDQ hash matched at distance ${pdq.bestDistance} below threshold ${config.pdqHammingThreshold} with quality ${pdq.quality}`,
      );
    }
    reason = reasonParts.join("; ");
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
