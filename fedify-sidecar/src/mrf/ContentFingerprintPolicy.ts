import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFMode } from "../admin/mrf/types.js";
import {
  contentFingerprintRegistration,
  type ContentFingerprintConfig,
} from "../admin/mrf/registry/modules/content-fingerprint.js";
import {
  type ContentFingerprintStore,
  normalizeContentForFingerprint,
  computeContentHash,
  extractActivityContent,
} from "../delivery/ContentFingerprintGuard.js";

export interface ContentFingerprintInput {
  activityId: string;
  actorUri: string;
  activity: Record<string, unknown>;
  originHost?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
}

export interface ContentFingerprintDecision {
  moduleId: "content-fingerprint";
  traceId: string;
  mode: MRFMode;
  desiredAction: "label" | "filter" | "reject";
  appliedAction: "accept" | "label" | "filter" | "reject";
  contentHash: string;
  distinctActorCount: number;
  reason?: string;
}

export async function evaluateContentFingerprint(
  mrfStore: MRFAdminStore | null,
  fingerprintStore: ContentFingerprintStore | null,
  input: ContentFingerprintInput,
  options?: {
    now?: () => string;
    requestId?: string;
  },
): Promise<ContentFingerprintDecision | null> {
  if (!mrfStore || !fingerprintStore) return null;

  const moduleConfig = await mrfStore.getModuleConfig("content-fingerprint");
  if (!moduleConfig || !moduleConfig.enabled) return null;

  const parsed = contentFingerprintRegistration.validateAndNormalizeConfig(moduleConfig.config, {
    existingConfig: contentFingerprintRegistration.getDefaultConfig(),
    partial: true,
  });
  const config = parsed.config as ContentFingerprintConfig;

  const rawContent = extractActivityContent(input.activity);
  if (!rawContent) return null;

  const normalized = normalizeContentForFingerprint(rawContent, config.normalizeUrls);

  if (config.minContentLength > 0 && normalized.length < config.minContentLength) {
    return null;
  }

  const contentHash = computeContentHash(normalized);
  const nowFn = options?.now ?? (() => new Date().toISOString());
  const timestamp = nowFn();
  const nowMs = new Date(timestamp).getTime();
  const windowStartMs = nowMs - config.windowHours * 60 * 60 * 1000;
  const ttlSeconds = config.windowHours * 60 * 60 + 3600;

  const distinctActorCount = await fingerprintStore.recordAndCount(
    contentHash,
    input.actorUri,
    windowStartMs,
    ttlSeconds,
  );

  if (distinctActorCount <= config.maxDistinctActors) {
    return null;
  }

  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const desiredAction = config.action;
  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";
  const reason = config.traceReasons
    ? `Content fingerprint: ${distinctActorCount} distinct actors sent identical content within ${config.windowHours}h — hash ${contentHash.slice(0, 12)}…`
    : undefined;

  await mrfStore.appendTrace({
    traceId,
    requestId,
    activityId: input.activityId,
    actorId: input.actorUri,
    originHost: input.originHost,
    visibility: input.visibility,
    moduleId: "content-fingerprint",
    mode: moduleConfig.mode,
    action: desiredAction,
    reason,
    createdAt: timestamp,
    redacted: false,
  });

  return {
    moduleId: "content-fingerprint",
    traceId,
    mode: moduleConfig.mode,
    desiredAction,
    appliedAction,
    contentHash,
    distinctActorCount,
    reason,
  };
}
