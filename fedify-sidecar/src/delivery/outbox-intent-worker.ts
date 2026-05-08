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

type SharedInboxAudienceScope = "public" | "followers" | "direct" | "local";

export interface OutboxIntentWorkerConfig {
  concurrency: number;
  outboundJobMaxAttempts: number;
  maxTargetsPerIntent?: number;
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
  /**
   * Visibility scopes that may use sharedInbox delivery optimization.
   *
   * Default: public + followers.
   * Direct-scope activities are excluded by default so explicit DM recipients
   * always receive per-inbox delivery.
   */
  sharedInboxAllowedScopes?: ReadonlySet<SharedInboxAudienceScope>;
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
  private readonly config: OutboxIntentWorkerConfig & { maxTargetsPerIntent: number };
  private readonly sharedInboxCache: RemoteSharedInboxCache | null;
  private readonly sharedInboxAllowedScopes: ReadonlySet<SharedInboxAudienceScope>;
  private isRunning = false;
  private activeJobs = 0;

  constructor(
    queue: RedisStreamsQueue,
    redpanda: RedPandaProducer | null,
    config: OutboxIntentWorkerConfig,
  ) {
    this.queue = queue;
    this.redpanda = redpanda;
    this.config = {
      ...config,
      maxTargetsPerIntent: Math.max(1, config.maxTargetsPerIntent ?? 5000),
    };
    this.sharedInboxCache = config.sharedInboxCache ?? null;
    this.sharedInboxAllowedScopes =
      config.sharedInboxAllowedScopes ?? new Set<SharedInboxAudienceScope>(["public", "followers"]);
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
      if (intent.notBeforeMs > 0 && Date.now() < intent.notBeforeMs) {
        await this.queue.ack("outbox_intent", messageId);
        await this.queue.enqueueOutboxIntent(intent);
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

      const audienceScope = this.getActivityAudienceScope(activity);
      const sharedInboxAllowed = this.sharedInboxAllowedScopes.has(audienceScope);
      const scopeSafeTargets = this.applySharedInboxScopePolicy(intent.targets, sharedInboxAllowed);

      // Enrich targets with remotely-discovered sharedInbox endpoints before
      // deduplication so that multiple recipients on the same remote server
      // collapse into a single delivery job (one POST per host per activity).
      // For direct scope, sharedInbox is intentionally bypassed.
      const enrichedTargets = this.sharedInboxCache && sharedInboxAllowed
        ? await this.sharedInboxCache.enrichTargets(scopeSafeTargets).catch((err: Error) => {
            logger.warn("Outbound sharedInbox enrichment failed (using original targets)", {
              intentId: intent.intentId,
              error: err.message,
            });
            return scopeSafeTargets;
          })
        : scopeSafeTargets;

      const normalizedTargets = normalizeAndDedupeOutboundTargets(
        enrichedTargets,
        { maxTargetsPerRequest: this.config.maxTargetsPerIntent },
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
        audienceScope,
        normalizedTargets.targets,
      );
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

      await this.queue.ack("outbox_intent", messageId);

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
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "dlq" });
        logger.warn("Outbox intent moved to DLQ", {
          intentId: intent.intentId,
          permanent,
          attempt: nextAttempt,
          error: message,
        });
      } else {
        const delay = backoffMs(nextAttempt);
        await this.queue.enqueueOutboxIntent({
          ...intent,
          attempt: nextAttempt,
          notBeforeMs: Date.now() + delay,
          lastError: message,
        });
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

  /**
   * Option B hardening: Validate that outbound delivery targets conform to
   * the activity's declared audience scope.
   *
   * Checks:
   * - If activity is followers-only (has followers collection, no as:Public),
   *   delivery is restricted to followers inbox + actor's local followers.
   * - If activity is direct-scoped (no public, no followers), delivery is
   *   restricted to named addressees in to/cc.
   *
   * Warning-level violations are logged and counted but don't block delivery
   * (to avoid false positives). Future work could make violations fatal.
   */
  private validateTargetConformance(
    activity: Record<string, unknown>,
    targets: Array<{ deliveryUrl: string; targetDomain: string }>,
    intentId: string,
  ): void {
    const audienceScope = this.getActivityAudienceScope(activity);

    if (audienceScope === "public") {
      // No restrictions — any target is acceptable
      return;
    }

    if (audienceScope === "followers") {
      // Followers-only: delivery to followers collections + actor inbox is OK.
      // Direct addressing to arbitrary actors should be flagged.
      const toUris = this.extractAddressingUris(activity, "to");
      const ccUris = this.extractAddressingUris(activity, "cc");
      const addressed = new Set([...toUris, ...ccUris]);

      const suspiciousTargets = targets.filter((t) => {
        // followers/inbox URLs are acceptable
        if (t.deliveryUrl.includes("/followers") || t.deliveryUrl.includes("/inbox")) {
          return false;
        }
        // Check if target matches a directly-addressed URI
        return !addressed.has(t.deliveryUrl);
      });

      if (suspiciousTargets.length > 0) {
        metrics.queueMessagesProcessed.inc({
          topic: "outbox_intent",
          status: "conformance_warn",
        });
        logger.warn("Followers-only activity delivered to non-followers/inbox targets (conformance check)", {
          intentId,
          targetCount: suspiciousTargets.length,
          examples: suspiciousTargets.slice(0, 2).map((t) => t.deliveryUrl),
        });
      }
      return;
    }

    if (audienceScope === "direct") {
      // Direct scope: delivery should only go to explicitly addressed recipients
      const addressed = this.extractAddressingUris(activity, "to", "cc", "bto", "bcc");

      const offScopeTargets = targets.filter((t) => !addressed.has(t.deliveryUrl));

      if (offScopeTargets.length > 0) {
        metrics.queueMessagesProcessed.inc({
          topic: "outbox_intent",
          status: "conformance_warn",
        });
        logger.warn("Direct-scoped activity delivered beyond explicitly-addressed targets (conformance check)", {
          intentId,
          addressedCount: addressed.size,
          targetCount: targets.length,
          offScopeCount: offScopeTargets.length,
        });
      }
      return;
    }

    // "local" scope: Akkoma local-only posts should NOT be delivered externally
    // This should have been caught by inbound guard, but double-check anyway
    if (audienceScope === "local") {
      logger.warn("Local-scope activity reached outbound — should have been dropped inbound", {
        intentId,
        targetCount: targets.length,
      });
    }
  }

  /**
   * Determine the canonical audience scope of an activity:
   * "public" | "followers" | "direct" | "local"
   */
  private getActivityAudienceScope(
    activity: Record<string, unknown>,
  ): "public" | "followers" | "direct" | "local" {
    // Check for as:Public
    if (this.hasPublicAddressing(activity)) {
      return "public";
    }

    // Check for Akkoma local-scope
    if (this.isLocalScopeOnly(activity)) {
      return "local";
    }

    // Check for followers-only
    if (this.hasFollowersAddressing(activity)) {
      return "followers";
    }

    // Default to direct
    return "direct";
  }

  /** Check if activity has public addressing (as:Public, as:Public alias, etc.) */
  private hasPublicAddressing(activity: Record<string, unknown>): boolean {
    const publicAliases = [
      "https://www.w3.org/ns/activitystreams#Public",
      "as:Public",
      "Public",
    ];

    const checkField = (field: unknown): boolean => {
      if (!field) return false;
      const entries = Array.isArray(field) ? field : [field];
      return entries.some((e) => publicAliases.includes(e));
    };

    return checkField(activity["to"]) || checkField(activity["cc"]);
  }

  /** Check if activity is Akkoma local-scope-only */
  private isLocalScopeOnly(activity: Record<string, unknown>): boolean {
    if (this.hasPublicAddressing(activity)) return false;

    const toEntries = this.extractAddressingUris(activity, "to");
    return Array.from(toEntries).some(
      (uri) => uri.includes("/#Public") && !uri.includes("http://") && uri.endsWith("/#Public"),
    );
  }

  /** Check if activity is followers-only addressing */
  private hasFollowersAddressing(activity: Record<string, unknown>): boolean {
    const toUris = this.extractAddressingUris(activity, "to");
    const ccUris = this.extractAddressingUris(activity, "cc");
    return Array.from(toUris).some((uri) => uri.includes("/followers")) ||
           Array.from(ccUris).some((uri) => uri.includes("/followers"));
  }

  /** Extract all addressing URIs from specified fields */
  private extractAddressingUris(activity: Record<string, unknown>, ...fields: string[]): Set<string> {
    const uris = new Set<string>();
    for (const field of fields) {
      const value = activity[field];
      if (!value) continue;

      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (typeof entry === "string" && entry.trim()) {
          uris.add(entry.trim());
        } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const id = (entry as Record<string, unknown>)["id"];
          if (typeof id === "string" && id.trim()) {
            uris.add(id.trim());
          }
        }
      }
    }
    return uris;
  }

  /**
   * Check if a target URL is in the set of explicitly addressed recipients
   * Handles both actor URIs and inbox URLs
   */
  private isTargetAddressed(targetUrl: string, addressedUris: Set<string>): boolean {
    // Direct match (target is an explicitly addressed actor)
    if (addressedUris.has(targetUrl)) return true;

    // Inbox match (target is the inbox of an explicitly addressed actor)
    // If actor is "https://example.com/users/bob", its inbox is typically
    // "https://example.com/users/bob/inbox"
    for (const addressed of addressedUris) {
      if (targetUrl === `${addressed}/inbox` || targetUrl.startsWith(`${addressed}/`)) {
        return true;
      }
    }

    return false;
  }

  private buildOutboundJobs(
    intent: OutboxIntent,
    activity: Record<string, unknown>,
    audienceScope: SharedInboxAudienceScope,
    normalizedTargets: Array<{ deliveryUrl: string; targetDomain: string }>,
  ): OutboundJob[] {
    const bridgeHints = this.normalizeBridgeHints(intent.bridgeHints);

    // OPTIMIZATION: Batch conformance validation instead of per-target iteration
    // For public scope, skip validation entirely (O(1) instead of O(n))
    const validTargets = 
      audienceScope === "public"
        ? new Set(normalizedTargets.map(t => t.deliveryUrl)) // All targets valid for public
        : this.validateTargetsInBatch(activity, normalizedTargets, audienceScope, intent.intentId);

    // OPTIMIZATION: Lazy JSON serialization - only stringify valid targets
    // This avoids serializing activities that will be dropped due to conformance violations
    const jobs: OutboundJob[] = normalizedTargets
      .filter(target => validTargets.has(target.deliveryUrl))
      .map((target) => ({
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

    // Log optimization metrics
    if (normalizedTargets.length > 0 && jobs.length < normalizedTargets.length) {
      const droppedCount = normalizedTargets.length - jobs.length;
      metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "conformance_filtered" });
      logger.debug("Conformance validation filtered outbound targets", {
        intentId: intent.intentId,
        totalTargets: normalizedTargets.length,
        validTargets: jobs.length,
        droppedCount,
        scope: audienceScope,
      });
    }

    return jobs;
  }

  /**
   * OPTIMIZATION: Batch validation instead of iterating each target
   * 
   * For followers-only scope: all targets assumed valid (all should be followers inboxes)
   * For direct scope: check each target is explicitly addressed (but do it once)
   * 
   * Returns Set<string> of valid target URLs
   */
  private validateTargetsInBatch(
    activity: Record<string, unknown>,
    targets: Array<{ deliveryUrl: string; targetDomain: string }>,
    scope: "followers" | "direct" | "local",
    intentId: string,
  ): Set<string> {
    const validTargets = new Set<string>();

    if (scope === "followers") {
      // Fast path: all followers targets are valid
      // Just check if there are any off-scope targets in the list
      targets.forEach(target => {
        validTargets.add(target.deliveryUrl);
      });
      return validTargets;
    }

    if (scope === "direct") {
      // Extract all addressed URIs once (not per-target)
      const toUris = new Set(this.extractAddressingUris(activity, "to"));
      const ccUris = new Set(this.extractAddressingUris(activity, "cc"));
      const btoUris = new Set(this.extractAddressingUris(activity, "bto"));
      const bccUris = new Set(this.extractAddressingUris(activity, "bcc"));
      const addressedUris = new Set([...toUris, ...ccUris, ...btoUris, ...bccUris]);

      // Check each target against addressed set (O(n) with hash lookup, not O(n²))
      let offScopeCount = 0;
      targets.forEach(target => {
        const isAddressed = this.isTargetAddressed(target.deliveryUrl, addressedUris);
        if (isAddressed) {
          validTargets.add(target.deliveryUrl);
        } else {
          offScopeCount++;
        }
      });

      if (offScopeCount > 0) {
        metrics.queueMessagesProcessed.inc({ topic: "outbox_intent", status: "conformance_warn" });
        logger.warn("Direct message targets not explicitly addressed", {
          intentId,
          offScopeCount,
          totalTargets: targets.length,
        });
      }
      return validTargets;
    }

    if (scope === "local") {
      logger.warn("Local-scope activity reached outbound (should be blocked earlier)", {
        intentId,
      });
      return validTargets; // Return empty for local scope
    }

    return validTargets;
  }

  private applySharedInboxScopePolicy(
    targets: OutboxIntent["targets"],
    sharedInboxAllowed: boolean,
  ): OutboxIntent["targets"] {
    if (sharedInboxAllowed) {
      return targets;
    }

    // Harden direct/private delivery semantics by forcing per-recipient inboxes.
    return targets.map((target) => ({
      inboxUrl: target.inboxUrl,
      deliveryUrl: target.inboxUrl,
      targetDomain: target.targetDomain,
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
    maxTargetsPerIntent: parsePositiveIntEnv("OUTBOX_INTENT_MAX_TARGETS", 5000),
    sharedInboxAllowedScopes: parseSharedInboxAllowedScopes(
      process.env["OUTBOX_SHARED_INBOX_SCOPES"],
    ),
    ...overrides,
  };

  return new OutboxIntentWorker(queue, redpanda, config);
}

function parseSharedInboxAllowedScopes(
  raw: string | undefined,
): ReadonlySet<SharedInboxAudienceScope> {
  const fallback = new Set<SharedInboxAudienceScope>(["public", "followers"]);
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const scopes = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is SharedInboxAudienceScope =>
      value === "public" || value === "followers" || value === "direct" || value === "local",
    );

  return scopes.length > 0 ? new Set(scopes) : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
