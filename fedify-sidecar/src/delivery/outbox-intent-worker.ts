import {
  RedisStreamsQueue,
  type OutboxIntent,
  type OutboundJob,
  backoffMs,
} from "../queue/sidecar-redis-queue.js";
import {
  applyActivityPubOutboundDeliveryPolicy,
  type ActivityPubOutboundDeliveryPolicy,
} from "../protocol-bridge/projectors/activitypub/ActivityPubDeliveryPolicy.js";
import type { ActivityPubBridgeActivityHints } from "../protocol-bridge/events/ActivityPubBridgeEvents.js";
import {
  normalizeAndDedupeOutboundTargets,
  OutboundWebhookValidationError,
} from "./outbound-webhook.js";
import type { RemoteSharedInboxCache } from "./RemoteSharedInboxCache.js";
import { metrics } from "../metrics/index.js";
import type { ActivityEventMeta, RedPandaProducer } from "../streams/redpanda-producer.js";
import { logger } from "../utils/logger.js";
import {
  APDM_OUTBOX_INTENT_MAX_AGE_MS,
  outboxIntentAgeMs,
} from "./apdm-replay-horizon.js";

export interface OutboxIntentWorkerConfig {
  concurrency: number;
  outboundJobMaxAttempts: number;
  activityPubOutboundDeliveryPolicy: ActivityPubOutboundDeliveryPolicy;
  /**
   * Optional sidecar-side remote sharedInbox discovery cache.
   *
   * When present, outbound targets that lack a `sharedInboxUrl` are enriched
   * by resolving the remote server's sharedInbox endpoint (fetched once per
   * domain, then cached in Redis for 24 h).  After enrichment the standard
   * deduplication collapses multiple recipients at the same remote host into a
   * single delivery job — reducing outbound HTTP requests per activity.
   *
   * Absent (or on enrichment error): falls back silently to per-inbox delivery.
   */
  sharedInboxCache?: RemoteSharedInboxCache;
}

class OutboxIntentProcessingError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
  ) {
    super(message);
    this.name = "OutboxIntentProcessingError";
  }
}

export class OutboxIntentWorker {
  private readonly queue: RedisStreamsQueue;
  private readonly redpanda: RedPandaProducer | null;
  private readonly config: OutboxIntentWorkerConfig;
  private readonly sharedInboxCache: RemoteSharedInboxCache | null;
  private isRunning = false;
  private activeJobs = 0;

  constructor(
    queue: RedisStreamsQueue,
    redpanda: RedPandaProducer | null,
    config: OutboxIntentWorkerConfig,
  ) {
    this.queue = queue;
    this.redpanda = redpanda;
    this.config = config;
    this.sharedInboxCache = config.sharedInboxCache ?? null;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Outbox intent worker started", {
      concurrency: this.config.concurrency,
      outboundJobMaxAttempts: this.config.outboundJobMaxAttempts,
    });

    for await (const { messageId, intent } of this.queue.consumeOutboxIntents()) {
      if (!this.isRunning) break;

      while (this.activeJobs >= this.config.concurrency) {
        await this.sleep(100);
      }

      this.processIntent(messageId, intent).catch((error: Error) => {
        logger.error("Unhandled error in outbox intent processing", {
          intentId: intent.intentId,
          error: error.message,
        });
      });
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    const timeoutAt = Date.now() + 30_000;
    while (this.activeJobs > 0 && Date.now() < timeoutAt) {
      await this.sleep(100);
    }

    logger.info("Outbox intent worker stopped", { remainingJobs: this.activeJobs });
  }

  protected async processIntent(messageId: string, intent: OutboxIntent): Promise<void> {
    this.activeJobs++;

    try {
      this.assertIntentWithinReplayHorizon(intent, "processing start");

      if (intent.notBeforeMs > 0 && Date.now() < intent.notBeforeMs) {
        // Persist the deferred replacement before ACKing the source message.
        // If enqueue fails, the original remains pending and reclaimable.
        await this.queue.enqueueOutboxIntent(intent);
        await this.queue.ack("outbox_intent", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "deferred" });
        logger.debug("Outbox intent not ready, requeued", {
          intentId: intent.intentId,
          notBefore: new Date(intent.notBeforeMs).toISOString(),
        });
        return;
      }

      const state = await this.queue.getOutboxIntentState(intent.intentId);
      if (state.completedAt) {
        await this.queue.ack("outbox_intent", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "duplicate" });
        metrics.queueProcessingLatency.observe(
          { topic: "outbox_intent" },
          Math.max(0, (state.completedAt - intent.createdAt) / 1000),
        );
        logger.debug("Outbox intent already completed, acknowledged duplicate", {
          intentId: intent.intentId,
          completedAt: state.completedAt,
        });
        return;
      }

      const activity = this.parseIntentActivity(intent);

      // Enrich targets with remotely-discovered sharedInbox endpoints before
      // deduplication so that multiple recipients on the same remote server
      // collapse into a single delivery job (one POST per host per activity).
      // Fault-isolated: enrichment errors fall back silently to per-inbox delivery.
      const enrichedTargets = this.sharedInboxCache
        ? await this.sharedInboxCache.enrichTargets(intent.targets).catch((err: Error) => {
            logger.warn("Outbound sharedInbox enrichment failed (using original targets)", {
              intentId: intent.intentId,
              error: err.message,
            });
            return intent.targets;
          })
        : intent.targets;

      const normalizedTargets = normalizeAndDedupeOutboundTargets(
        enrichedTargets,
        { maxTargetsPerRequest: Math.max(enrichedTargets.length, 1) },
      );
      if (normalizedTargets.targets.length === 0) {
        throw new OutboxIntentProcessingError(
          "Outbox intent does not contain any valid delivery targets",
          true,
        );
      }

      if (normalizedTargets.invalidTargetCount > 0 || normalizedTargets.duplicateTargetCount > 0) {
        logger.warn("Outbox intent targets required runtime normalization", {
          intentId: intent.intentId,
          invalidTargetCount: normalizedTargets.invalidTargetCount,
          duplicateTargetCount: normalizedTargets.duplicateTargetCount,
        });
      }

      if (!state.eventLogPublishedAt) {
        await this.publishEventLog(intent, activity);
        await this.queue.markOutboxIntentEventLogPublished(intent.intentId);
      }

      const outboundJobs = this.buildOutboundJobs(
        intent,
        activity,
        normalizedTargets.targets,
      );

      // Enrichment and event-log publication are awaited and may stall. Check
      // the original accepted-at clock again at the actual fan-out boundary so
      // a fresh outbound Redis Stream timestamp cannot extend stale replay work.
      this.assertIntentWithinReplayHorizon(intent, "outbound fan-out");

      const enqueueResult = await this.queue.enqueueOutboundBatchForIntent(
        intent.intentId,
        outboundJobs,
      );

      await this.queue.markOutboxIntentCompleted(intent.intentId);
      await this.queue.ack("outbox_intent", messageId);

      metrics.queueMessagesProcessed.inc({
        topic: "outbox_intent",
        status: enqueueResult.enqueued ? "success" : "deduped",
      });
      metrics.queueProcessingLatency.observe(
        { topic: "outbox_intent" },
        Math.max(0, (Date.now() - intent.createdAt) / 1000),
      );

      logger.info("Outbox intent completed", {
        intentId: intent.intentId,
        activityId: intent.activityId,
        targetCount: normalizedTargets.targets.length,
        outboundEnqueued: enqueueResult.enqueued,
        jobCount: enqueueResult.jobCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = this.isPermanentFailure(error);
      const nextAttempt = intent.attempt + 1;

      if (permanent || nextAttempt >= intent.maxAttempts) {
        // DLQ is the durable recovery record. Write it before ACKing the source
        // message so a crash or Redis error cannot make rejected work disappear.
        await this.queue.moveToDlq(
          "outbox_intent",
          {
            ...intent,
            attempt: nextAttempt,
            lastError: message,
          },
          permanent ? message : "Max attempts exceeded",
        );
        await this.queue.ack("outbox_intent", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "dlq" });
        logger.warn("Outbox intent moved to DLQ", {
          intentId: intent.intentId,
          permanent,
          attempt: nextAttempt,
          error: message,
        });
      } else {
        const delay = backoffMs(nextAttempt);
        // Persist retry work before ACKing the source message. If enqueue fails,
        // the original remains pending for Redis Stream recovery.
        await this.queue.enqueueOutboxIntent({
          ...intent,
          attempt: nextAttempt,
          notBeforeMs: Date.now() + delay,
          lastError: message,
        });
        await this.queue.ack("outbox_intent", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "retry" });
        logger.warn("Outbox intent failed, scheduled retry", {
          intentId: intent.intentId,
          attempt: nextAttempt,
          retryAt: new Date(Date.now() + delay).toISOString(),
          error: message,
        });
      }

      metrics.queueProcessingLatency.observe(
        { topic: "outbox_intent" },
        Math.max(0, (Date.now() - intent.createdAt) / 1000),
      );
    } finally {
      this.activeJobs--;
    }
  }

  private assertIntentWithinReplayHorizon(intent: OutboxIntent, boundary: string): void {
    const intentAgeMs = outboxIntentAgeMs(intent.createdAt);
    if (intentAgeMs === null) {
      throw new OutboxIntentProcessingError(
        `Outbox intent has an invalid or implausibly future createdAt timestamp at ${boundary}`,
        true,
      );
    }
    if (intentAgeMs > APDM_OUTBOX_INTENT_MAX_AGE_MS) {
      throw new OutboxIntentProcessingError(
        `Outbox intent exceeded the ${APDM_OUTBOX_INTENT_MAX_AGE_MS} ms APDM replay residence limit at ${boundary}`,
        true,
      );
    }
  }

  private parseIntentActivity(intent: OutboxIntent): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(intent.activity);
    } catch (error) {
      throw new OutboxIntentProcessingError(
        `Outbox intent activity is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OutboxIntentProcessingError(
        "Outbox intent activity must be a JSON object",
        true,
      );
    }

    return parsed as Record<string, unknown>;
  }

  private async publishEventLog(
    intent: OutboxIntent,
    activity: Record<string, unknown>,
  ): Promise<void> {
    const activityType = typeof activity["type"] === "string" ? activity["type"] : undefined;
    if (activityType === "Delete" || activityType === "Tombstone") {
      if (!this.redpanda) {
        throw new OutboxIntentProcessingError(
          "RedPanda producer is unavailable for tombstone publication",
          false,
        );
      }

      const objectValue = activity["object"];
      const objectId =
        typeof objectValue === "string"
          ? objectValue
          : this.extractObjectId(objectValue);

      await this.redpanda.publishTombstone({
        activityId: intent.activityId,
        objectId,
        actorUri: intent.actorUri,
        deletedAt: Date.now(),
        outboxIntentId: intent.intentId,
      });
      return;
    }

    const isPublicActivity =
      intent.meta?.isPublicActivity === true ||
      intent.meta?.visibility === "public" ||
      intent.meta?.visibility === "unlisted";

    if (!isPublicActivity) {
      return;
    }

    if (!this.redpanda) {
      throw new OutboxIntentProcessingError(
        "RedPanda producer is unavailable for local public activity publication",
        false,
      );
    }

    await this.redpanda.publishToStream1({
      activity,
      actorUri: intent.actorUri,
      publishedAt: Date.now(),
      origin: "local",
      meta: intent.meta as ActivityEventMeta | undefined,
      outboxIntentId: intent.intentId,
    });
  }

  private buildOutboundJobs(
    intent: OutboxIntent,
    activity: Record<string, unknown>,
    normalizedTargets: Array<{ deliveryUrl: string; targetDomain: string }>,
  ): OutboundJob[] {
    const bridgeHints = this.normalizeBridgeHints(intent.bridgeHints);

    return normalizedTargets.map((target) => ({
      jobId: `${intent.activityId}::${target.deliveryUrl}`,
      activityId: intent.activityId,
      actorUri: intent.actorUri,
      activity: JSON.stringify(
        applyActivityPubOutboundDeliveryPolicy(
          activity,
          target.targetDomain,
          bridgeHints,
          this.config.activityPubOutboundDeliveryPolicy,
        ),
      ),
      targetInbox: target.deliveryUrl,
      targetDomain: target.targetDomain,
      attempt: 0,
      maxAttempts: this.config.outboundJobMaxAttempts,
      notBeforeMs: 0,
      meta: intent.meta,
    }));
  }

  private normalizeBridgeHints(
    bridgeHints: OutboxIntent["bridgeHints"],
  ): ActivityPubBridgeActivityHints | undefined {
    if (!bridgeHints || typeof bridgeHints !== "object" || Array.isArray(bridgeHints)) {
      return undefined;
    }

    const noteLinkPreviewUrls = Array.isArray(bridgeHints["noteLinkPreviewUrls"])
      ? bridgeHints["noteLinkPreviewUrls"].filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : undefined;

    return noteLinkPreviewUrls && noteLinkPreviewUrls.length > 0
      ? { noteLinkPreviewUrls }
      : undefined;
  }

  private extractObjectId(objectValue: unknown): string | undefined {
    if (!objectValue || typeof objectValue !== "object" || Array.isArray(objectValue)) {
      return undefined;
    }

    const value = objectValue as Record<string, unknown>;
    return typeof value["id"] === "string" ? value["id"] : undefined;
  }

  private isPermanentFailure(error: unknown): boolean {
    if (error instanceof OutboxIntentProcessingError) {
      return error.permanent;
    }

    if (error instanceof OutboundWebhookValidationError) {
      return error.statusCode >= 400 && error.statusCode < 500;
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createOutboxIntentWorker(
  queue: RedisStreamsQueue,
  redpanda: RedPandaProducer | null,
  overrides: Partial<OutboxIntentWorkerConfig> & {
    activityPubOutboundDeliveryPolicy: ActivityPubOutboundDeliveryPolicy;
  },
): OutboxIntentWorker {
  const config: OutboxIntentWorkerConfig = {
    concurrency: parseInt(process.env["OUTBOX_INTENT_CONCURRENCY"] || "8", 10),
    outboundJobMaxAttempts: parseInt(process.env["OUTBOUND_MAX_ATTEMPTS"] || "10", 10),
    ...overrides,
  };

  return new OutboxIntentWorker(queue, redpanda, config);
}
