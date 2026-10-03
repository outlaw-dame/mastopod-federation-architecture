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
import {
  createRedisOutboxIntentDelaySchedulerFromEnv,
  type OutboxIntentDelayScheduler,
} from "./outbox-intent-delay-scheduler.js";

export interface OutboxIntentWorkerConfig {
  concurrency: number;
  outboundJobMaxAttempts: number;
  activityPubOutboundDeliveryPolicy: ActivityPubOutboundDeliveryPolicy;
  delayScheduler?: OutboxIntentDelayScheduler;
  /**
   * Legacy construction seam retained temporarily for source compatibility.
   * APDM delivery targets already carry the authoritative per-recipient
   * sharedInboxUrl resolved by ActivityPods, so the worker deliberately does
   * not perform sidecar actor rediscovery. Missing sharedInboxUrl falls back
   * to the recipient's personal inbox.
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
  private readonly delayScheduler: OutboxIntentDelayScheduler | null;
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
    this.delayScheduler = config.delayScheduler ?? null;
  }

  async start(): Promise<void> {
    if (!this.delayScheduler) {
      throw new Error("Outbox intent worker requires a durable delay scheduler before queue consumption");
    }
    await this.delayScheduler.start();
    this.isRunning = true;
    logger.info("Outbox intent worker started", {
      concurrency: this.config.concurrency,
      outboundJobMaxAttempts: this.config.outboundJobMaxAttempts,
    });

    try {
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
    } finally {
      this.isRunning = false;
      await this.delayScheduler.stop().catch(error => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to stop outbox-intent delay scheduler",
        );
      });
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    const timeoutAt = Date.now() + 30_000;
    while (this.activeJobs > 0 && Date.now() < timeoutAt) {
      await this.sleep(100);
    }

    if (this.delayScheduler) await this.delayScheduler.stop();
    logger.info("Outbox intent worker stopped", { remainingJobs: this.activeJobs });
  }

  protected async processIntent(messageId: string, intent: OutboxIntent): Promise<void> {
    this.activeJobs++;
    let parkingAlreadyFutureIntent = false;

    try {
      this.assertIntentWithinReplayHorizon(intent, "processing start");

      if (intent.notBeforeMs > 0 && Date.now() < intent.notBeforeMs) {
        parkingAlreadyFutureIntent = true;
        await this.persistDelayedReplacementAndAck(messageId, intent);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "deferred" });
        logger.debug("Outbox intent not ready, parked in durable delayed store", {
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

      // Stream1 is the provider-wide observation log for committed local public
      // ActivityPub activity. Its publication is therefore independent of
      // whether this intent has any remote delivery targets or whether later
      // delivery normalization succeeds. The Redis state marker suppresses
      // ordinary reprocessing. A crash after the broker ACK but before the
      // marker is persisted can still replay physically, so consumers must
      // dedupe by the stable outboxIntentId carried in the RedPanda record.
      if (!state.eventLogPublishedAt) {
        await this.publishEventLog(intent, activity);
        await this.queue.markOutboxIntentEventLogPublished(intent.intentId);
      }

      // A committed Activity with no remote recipients is a legitimate APDM
      // outcome, not a malformed delivery request. Complete it after durable
      // observation without manufacturing a recipient or a second routing path.
      if (intent.targets.length === 0) {
        const enqueueResult = await this.queue.enqueueOutboundBatchForIntent(intent.intentId, []);
        await this.queue.markOutboxIntentCompleted(intent.intentId);
        await this.queue.ack("outbox_intent", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "observation" });
        metrics.queueProcessingLatency.observe(
          { topic: "outbox_intent" },
          Math.max(0, (Date.now() - intent.createdAt) / 1000),
        );
        logger.info("Zero-target outbox intent completed after local observation", {
          intentId: intent.intentId,
          activityId: intent.activityId,
          explicitObservationOnly: this.isExplicitObservationOnlyIntent(intent),
          outboundEnqueued: enqueueResult.enqueued,
          jobCount: enqueueResult.jobCount,
        });
        return;
      }

      // ActivityPods is the APDM recipient authority and has already resolved
      // each remote actor's personal inbox plus optional endpoints.sharedInbox.
      // Re-normalize and dedupe that durable target snapshot, but never fetch a
      // remote actor again here merely to discover a shared inbox. This keeps
      // shared-inbox use optional: supplied exact endpoint when known, personal
      // inbox fallback when absent.
      const normalizedTargets = normalizeAndDedupeOutboundTargets(
        intent.targets,
        { maxTargetsPerRequest: Math.max(intent.targets.length, 1) },
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

      const outboundJobs = this.buildOutboundJobs(
        intent,
        activity,
        normalizedTargets.targets,
      );

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

      // Completion is represented by durable markers and Prometheus counters.
      // Keep per-intent identifiers at debug level so normal production load
      // does not turn successful fan-out into synchronous high-cardinality log
      // traffic. Warnings and failures remain visible at their existing levels.
      logger.debug("Outbox intent completed", {
        intentId: intent.intentId,
        activityId: intent.activityId,
        targetCount: normalizedTargets.targets.length,
        outboundEnqueued: enqueueResult.enqueued,
        jobCount: enqueueResult.jobCount,
      });
    } catch (error) {
      // A future-dated intent has not attempted ActivityPub processing yet. If
      // its durable parking transition fails, leave the original Stream entry
      // pending and surface the infrastructure error without consuming a
      // business retry attempt or manufacturing another replacement.
      if (parkingAlreadyFutureIntent) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const permanent = this.isPermanentFailure(error);
      const nextAttempt = intent.attempt + 1;

      if (permanent || nextAttempt >= intent.maxAttempts) {
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
        const replacement = {
          ...intent,
          attempt: nextAttempt,
          notBeforeMs: Date.now() + delay,
          lastError: message,
        };
        await this.persistDelayedReplacementAndAck(messageId, replacement);
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "retry" });
        logger.warn("Outbox intent failed, scheduled durable delayed retry", {
          intentId: intent.intentId,
          attempt: nextAttempt,
          retryAt: new Date(replacement.notBeforeMs).toISOString(),
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

  private async persistDelayedReplacementAndAck(messageId: string, intent: OutboxIntent): Promise<void> {
    if (!this.delayScheduler) {
      throw new Error("Outbox intent delayed work requires a durable delay scheduler");
    }
    await this.delayScheduler.persistReplacementAndAck(messageId, intent);
  }

  private isExplicitObservationOnlyIntent(intent: OutboxIntent): boolean {
    return Boolean(
      intent.bridgeHints &&
      typeof intent.bridgeHints === "object" &&
      !Array.isArray(intent.bridgeHints) &&
      intent.bridgeHints["observationOnly"] === true,
    );
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
    const isLifecycleRemoval =
      activityType === "Delete" ||
      activityType === "Tombstone" ||
      (activityType === "Undo" && intent.meta?.isDeleteOrTombstone === true);

    // ActivityPub "unlisted" activities are still addressed to Public (usually
    // via cc) and therefore belong to the public federation event stream. Search
    // and discovery eligibility remain separately constrained by searchConsent
    // and isPublicIndexable metadata.
    const isPublicActivity =
      intent.meta?.isPublicActivity === true ||
      intent.meta?.visibility === "public" ||
      intent.meta?.visibility === "unlisted";

    if (isLifecycleRemoval) {
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
        deletedAt: intent.createdAt,
        outboxIntentId: intent.intentId,
        streamTimestamp: intent.createdAt,
      });
    }

    if (!isPublicActivity) return;

    if (!this.redpanda) {
      throw new OutboxIntentProcessingError(
        "RedPanda producer is unavailable for local public activity publication",
        false,
      );
    }

    // Lifecycle records and ActivityPub lifecycle activities are separate
    // outputs. A federation-public Delete/relevant Undo therefore appears in
    // Stream1 + firehose and also gets a tombstone, symmetric with Stream2.
    await this.redpanda.publishToStream1({
      activity,
      actorUri: intent.actorUri,
      publishedAt: intent.createdAt,
      origin: "local",
      meta: intent.meta as ActivityEventMeta | undefined,
      outboxIntentId: intent.intentId,
      streamTimestamp: intent.createdAt,
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
    if (error instanceof OutboxIntentProcessingError) return error.permanent;
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
    delayScheduler: createRedisOutboxIntentDelaySchedulerFromEnv(),
    ...overrides,
  };

  return new OutboxIntentWorker(queue, redpanda, config);
}
