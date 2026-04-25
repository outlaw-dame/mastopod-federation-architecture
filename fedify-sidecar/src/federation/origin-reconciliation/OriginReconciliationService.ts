import { createHash, randomUUID } from "node:crypto";
import type { RedisStreamsQueue } from "../../queue/sidecar-redis-queue.js";
import {
  extractAttributedTo,
  extractContextCollectionUri,
  extractContextHistoryUri,
  extractId,
  extractRepliesUri,
} from "../replies-backfill/RepliesBackfillService.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_ACTIVATION_WINDOW_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export interface OriginReconciliationServiceConfig {
  queue: RedisStreamsQueue;
  domain: string;
  initialDelayMs?: number;
  activationWindowMs?: number;
  maxAttempts?: number;
}

interface NoteLikeRecord extends Record<string, unknown> {}

export class OriginReconciliationService {
  private readonly queue: RedisStreamsQueue;
  private readonly domain: string;
  private readonly initialDelayMs: number;
  private readonly activationWindowMs: number;
  private readonly maxAttempts: number;

  constructor(config: OriginReconciliationServiceConfig) {
    this.queue = config.queue;
    this.domain = config.domain;
    this.initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.activationWindowMs = config.activationWindowMs ?? DEFAULT_ACTIVATION_WINDOW_MS;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async scheduleFromActivity(activity: unknown): Promise<void> {
    const noteObject = extractNoteLikeObject(activity);
    if (!noteObject) {
      return;
    }

    const objectId = extractId(noteObject);
    if (!objectId || !isHttpUrl(objectId) || isLocalToDomain(objectId, this.domain)) {
      return;
    }

    const activityRecord = isRecord(activity) ? activity : null;
    const hasConversationSignals =
      !!extractRepliesUri(noteObject)
      || !!extractContextCollectionUri(noteObject)
      || !!extractContextHistoryUri(noteObject)
      || !!extractContextCollectionUri(activityRecord)
      || !!extractContextHistoryUri(activityRecord);

    if (!hasConversationSignals) {
      return;
    }

    const claimed = await this.queue.claimOriginReconciliation(
      objectId,
      Math.ceil(this.activationWindowMs / 1000),
    );
    if (!claimed) {
      logger.debug("[origin-reconcile] active reconciliation window already exists", {
        originObjectUrl: objectId,
      });
      return;
    }

    const actorUriHint = extractAttributedTo(noteObject)
      ?? (activityRecord ? extractAttributedTo(activityRecord) : null)
      ?? undefined;
    const now = Date.now();

    await this.queue.enqueueOriginReconciliation({
      jobId: randomUUID(),
      originObjectUrl: objectId,
      canonicalObjectId: objectId,
      actorUriHint,
      reason: "conversation-hydration",
      createdAt: now,
      attempt: 0,
      maxAttempts: this.maxAttempts,
      notBeforeMs: now + this.initialDelayMs,
      windowExpiresAt: now + this.activationWindowMs,
      lastFingerprint: fingerprintJsonObject(noteObject),
      unchangedSuccesses: 0,
      notFoundCount: 0,
    });

    logger.debug("[origin-reconcile] scheduled reconciliation window", {
      originObjectUrl: objectId,
      actorUriHint,
      maxAttempts: this.maxAttempts,
      windowExpiresAt: new Date(now + this.activationWindowMs).toISOString(),
    });
  }
}

export function fingerprintJsonObject(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function extractNoteLikeObject(activity: unknown): NoteLikeRecord | null {
  if (!isRecord(activity)) return null;

  const type = activity["type"];
  const noteTypes = new Set(["Note", "Article", "Page", "Question"]);
  if (typeof type === "string" && noteTypes.has(type)) {
    return activity;
  }

  const wrappingTypes = new Set(["Create", "Update", "Announce"]);
  if (typeof type === "string" && wrappingTypes.has(type) && isRecord(activity["object"])) {
    const object = activity["object"] as NoteLikeRecord;
    const innerType = object["type"];
    if (typeof innerType === "string" && noteTypes.has(innerType)) {
      return object;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalToDomain(uri: string, domain: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.hostname === domain;
  } catch {
    return false;
  }
}