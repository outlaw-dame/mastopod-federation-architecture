/**
 * Outbound Delivery Worker
 *
 * Processes outbound delivery jobs from the Redis Streams queue.
 * Handles HTTP signature requests, delivery, retry logic, and dead-lettering.
 *
 * Key principles:
 * - Crash-safe in-flight claim is distinct from completed-delivery idempotency
 * - Body is immutable (signed bytes = sent bytes)
 * - Domain rate limiting and concurrency control
 * - Exponential backoff with Mastodon-compatible tiers
 * - Shared inbox optimization
 */

import { randomUUID } from "node:crypto";
import { request } from "undici";
import { isIP } from "node:net";
import {
  RedisStreamsQueue,
  OutboundJob,
  backoffMs,
} from "../queue/sidecar-redis-queue.js";
import { SigningClient, SignResult, SignErrorResult } from "../signing/signing-client.js";
import { RedPandaProducer } from "../streams/redpanda-producer.js";
import {
  FederationRuntimeAdapter,
  NoopFederationRuntimeAdapter,
  type OutboundDeliveryResult,
} from "../core-domain/contracts/SigningContracts.js";
import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";
import type { CapabilityGateResult } from "../capabilities/gates.js";
import type { FollowersSyncService } from "../federation/fep8fcf/FollowersSyncService.js";
import { extractActorIdentifier } from "../federation/fep8fcf/PartialFollowersDigest.js";
import { COLLECTION_SYNC_HEADER } from "../federation/fep8fcf/CollectionSyncHeader.js";
import {
  RedisOutboundDeliveryClaimStore,
  type OutboundDeliveryClaimStore,
} from "./outbound-delivery-claims.js";
import {
  APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
  outboxIntentAgeMs,
} from "./apdm-replay-horizon.js";

// ============================================================================
// Types
// ============================================================================

export interface OutboundWorkerConfig {
  concurrency: number;
  maxConcurrentPerDomain: number;
  requestTimeoutMs: number;
  userAgent: string;
  notReadyMaxRequeues?: number;
  notReadyMinDelayMs?: number;
  notReadyJitterMs?: number;
  queueTelemetryIntervalMs?: number;
  heapWarnMb?: number;
  deliveryClaimTtlMs?: number;
  deliveryCompletedTtlMs?: number;
  deliveryClaimStore?: OutboundDeliveryClaimStore;
  capabilityGate?: (capabilityId: string) => CapabilityGateResult;
  fedifyRuntimeIntegrationEnabled: boolean;
  /** Injected adapter — defaults to NoopFederationRuntimeAdapter when flag is off. */
  adapter?: FederationRuntimeAdapter;
  /**
   * FEP-8fcf followers sync service.  When present and the outbound job has
   * `meta.visibility === "followers"`, the worker appends a
   * Collection-Synchronization header to the HTTP delivery request.
   */
  followersSyncService?: FollowersSyncService;
  /**
   * Public hostname of this sidecar (e.g. "social.example.com").  Required
   * to extract the actor identifier from an actorUri for FEP-8fcf.
   */
  domain?: string;
}

type NormalizedOutboundWorkerConfig = OutboundWorkerConfig & {
  notReadyMaxRequeues: number;
  notReadyMinDelayMs: number;
  notReadyJitterMs: number;
  queueTelemetryIntervalMs: number;
  heapWarnMb: number;
  deliveryClaimTtlMs: number;
  deliveryCompletedTtlMs: number;
};

export interface DeliveryResult extends OutboundDeliveryResult {}

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_ERROR_TEXT_LENGTH = 512;
const MAX_RESPONSE_BODY_LOG_LENGTH = 2048;
/**
 * Keep short scheduling waits on the original pending Stream entry. This is
 * intentionally well below the queue's normal 60s XAUTOCLAIM idle threshold,
 * so ordinary per-domain deferrals do not create immediately-consumable
 * replacement entries that can burn the deferral budget in a hot loop.
 * Longer waits remain pending and are recovered by XAUTOCLAIM instead.
 */
export const MAX_INLINE_NOT_BEFORE_WAIT_MS = 2_000;

export class OutboundResidenceExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundResidenceExpiredError";
  }
}

export function sanitizeErrorText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "unknown");
  const compact = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return compact
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .slice(0, MAX_ERROR_TEXT_LENGTH);
}

export function sanitizeResponseBodySnippet(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, "").trim();
  if (!compact) return undefined;
  return compact.slice(0, MAX_RESPONSE_BODY_LOG_LENGTH);
}

export function parseRetryAfterMs(
  retryAfterHeader: string | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!retryAfterHeader) return undefined;

  const asSeconds = Number.parseInt(retryAfterHeader, 10);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(asSeconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const asDateMs = Date.parse(retryAfterHeader);
  if (Number.isNaN(asDateMs)) return undefined;

  const delta = Math.max(0, asDateMs - nowMs);
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

export function isSafeTargetInboxUrl(targetInbox: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetInbox);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();

  if (protocol === "https:") return true;
  if (protocol !== "http:") return false;

  if (host === "localhost" || host === "::1") return true;
  const ipVersion = isIP(host);
  return ipVersion === 4 && host.startsWith("127.");
}

class LegacyQueueTestClaimStore implements OutboundDeliveryClaimStore {
  constructor(private readonly queue: RedisStreamsQueue) {}

  async claim(jobId: string, _claimToken: string, _ttlMs: number): Promise<"claimed" | "completed"> {
    const isNew = await this.queue.checkIdempotency({ jobId } as OutboundJob);
    return isNew ? "claimed" : "completed";
  }

  async complete(): Promise<void> {}

  async release(jobId: string): Promise<void> {
    await this.queue.clearIdempotency({ jobId } as OutboundJob);
  }

  async close(): Promise<void> {}
}

// ============================================================================
// Outbound Worker
// ============================================================================

export class OutboundWorker {
  private queue: RedisStreamsQueue;
  private signingClient: SigningClient;
  private redpanda: RedPandaProducer;
  private config: NormalizedOutboundWorkerConfig;
  private adapter: FederationRuntimeAdapter;
  private followersSyncService: FollowersSyncService | null;
  private deliveryClaimStore: OutboundDeliveryClaimStore;
  private ownsDeliveryClaimStore: boolean;
  private isRunning = false;
  private activeJobs = 0;
  private telemetryTimer: NodeJS.Timeout | null = null;

  constructor(
    queue: RedisStreamsQueue,
    signingClient: SigningClient,
    redpanda: RedPandaProducer,
    config: OutboundWorkerConfig
  ) {
    this.queue = queue;
    this.signingClient = signingClient;
    this.redpanda = redpanda;
    const defaultClaimTtlMs = Math.max(120_000, config.requestTimeoutMs * 2 + 30_000);
    this.config = {
      ...config,
      notReadyMaxRequeues: config.notReadyMaxRequeues ?? 32,
      notReadyMinDelayMs: config.notReadyMinDelayMs ?? 500,
      notReadyJitterMs: config.notReadyJitterMs ?? 250,
      queueTelemetryIntervalMs: config.queueTelemetryIntervalMs ?? 15000,
      heapWarnMb: config.heapWarnMb ?? 1024,
      deliveryClaimTtlMs: config.deliveryClaimTtlMs ?? defaultClaimTtlMs,
      deliveryCompletedTtlMs: config.deliveryCompletedTtlMs ?? 24 * 60 * 60 * 1000,
    } as NormalizedOutboundWorkerConfig;
    this.adapter = config.fedifyRuntimeIntegrationEnabled
      ? (config.adapter ?? NoopFederationRuntimeAdapter)
      : NoopFederationRuntimeAdapter;
    this.followersSyncService = config.followersSyncService ?? null;
    this.ownsDeliveryClaimStore = !config.deliveryClaimStore;
    this.deliveryClaimStore = config.deliveryClaimStore
      ?? (process.env["NODE_ENV"] === "test"
        ? new LegacyQueueTestClaimStore(queue)
        : new RedisOutboundDeliveryClaimStore(process.env["REDIS_URL"] ?? "redis://localhost:6379"));
  }

  /**
   * Invoke a FederationRuntimeAdapter hook inside a noop-safe circuit-breaker.
   * Errors thrown by the adapter are logged and swallowed — they must never
   * affect the calling business-logic path.
   */
  private async callAdapter(
    hook: "onOutboundDelivered" | "onOutboundPermanentFailure",
    input:
      | NonNullable<Parameters<NonNullable<FederationRuntimeAdapter["onOutboundDelivered"]>>[0]>
      | NonNullable<Parameters<NonNullable<FederationRuntimeAdapter["onOutboundPermanentFailure"]>>[0]>
  ): Promise<void> {
    if (!this.adapter.enabled) return;
    const fn = this.adapter[hook] as
      | FederationRuntimeAdapter["onOutboundDelivered"]
      | FederationRuntimeAdapter["onOutboundPermanentFailure"];
    if (!fn) return;
    try {
      await fn.call(this.adapter, input as never);
    } catch (err: any) {
      logger.warn("FederationRuntimeAdapter hook threw (swallowed)", {
        hook,
        error: err.message,
      });
    }
  }

  /** Start the worker loop. */
  async start(): Promise<void> {
    this.isRunning = true;
    this.startTelemetryLoop();
    logger.info("Outbound worker started", {
      concurrency: this.config.concurrency,
      fedifyRuntimeIntegrationEnabled: this.config.fedifyRuntimeIntegrationEnabled,
    });

    for await (const { messageId, job } of this.queue.consumeOutbound()) {
      if (!this.isRunning) break;

      while (this.activeJobs >= this.config.concurrency) {
        await this.sleep(100);
      }

      this.processJob(messageId, job).catch(err => {
        logger.error("Unhandled error in job processing", { jobId: job.jobId, error: err.message });
      });
    }
  }

  /** Stop the worker gracefully. */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }

    const timeout = Date.now() + 30000;
    while (this.activeJobs > 0 && Date.now() < timeout) {
      await this.sleep(100);
    }

    if (this.ownsDeliveryClaimStore) {
      await this.deliveryClaimStore.close().catch(err => {
        logger.warn("Failed to close outbound delivery claim store", { error: sanitizeErrorText(err) });
      });
    }

    logger.info("Outbound worker stopped", { remainingJobs: this.activeJobs });
  }

  getConcurrency(): number {
    return this.config.concurrency;
  }

  setConcurrency(nextConcurrency: number): void {
    const normalized = Math.max(1, Math.floor(nextConcurrency));
    if (normalized === this.config.concurrency) return;

    const previous = this.config.concurrency;
    this.config.concurrency = normalized;
    logger.info("Outbound worker concurrency updated", { previous, next: normalized });
  }

  getMaxConcurrentPerDomain(): number {
    return this.config.maxConcurrentPerDomain;
  }

  setMaxConcurrentPerDomain(nextLimit: number): void {
    const normalized = Math.max(1, Math.floor(nextLimit));
    if (normalized === this.config.maxConcurrentPerDomain) return;

    const previous = this.config.maxConcurrentPerDomain;
    this.config.maxConcurrentPerDomain = normalized;
    logger.info("Outbound per-domain concurrency updated", { previous, next: normalized });
  }

  /**
   * Process a single delivery job.
   *
   * Redis Stream acknowledgement is deliberately last in every requeue/DLQ
   * transition: replacement work is durably inserted before the old message is
   * acknowledged, so a process crash cannot create an ACK -> requeue loss gap.
   */
  protected async processJob(messageId: string, job: OutboundJob): Promise<void> {
    this.activeJobs++;
    const deliveryStartedAt = Date.now();
    const claimToken = randomUUID();
    let claimHeld = false;

    try {
      const firstQueuedAtMs = job.meta?.apdmFirstQueuedAtMs;
      const syntheticDirectTestMessage = process.env["NODE_ENV"] === "test" && /^msg-\d+$/.test(messageId);
      const queueResidenceMs = typeof firstQueuedAtMs === "number"
        ? outboxIntentAgeMs(firstQueuedAtMs, deliveryStartedAt)
        : syntheticDirectTestMessage
          ? 0
          : null;
      if (queueResidenceMs === null || queueResidenceMs > APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS) {
        const reason = queueResidenceMs === null
          ? "Outbound message is missing a valid preserved first-enqueue timestamp"
          : `Outbound message exceeded the ${APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS} ms APDM queue residence limit`;
        await this.queue.moveToDlq("outbound", { ...job, lastError: reason }, reason);
        await this.queue.ack("outbound", messageId);
        metrics.deliveryDlq.inc({ domain: job.targetDomain });
        metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "queue_expired" });
        logger.warn("Outbound delivery expired before duplicate claim check", {
          jobId: job.jobId,
          activityId: job.activityId,
          firstQueuedAtMs,
          queueResidenceMs,
          maxQueueResidenceMs: APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
        });
        return;
      }

      if (this.config.capabilityGate) {
        const gate = this.config.capabilityGate("ap.federation.egress");
        if (!gate.allowed) {
          await this.queue.moveToDlq(
            "outbound",
            job,
            gate.message || `Capability denied: ${gate.reasonCode || "feature_disabled"}`,
          );
          await this.queue.ack("outbound", messageId);
          logger.warn("Outbound delivery skipped by capability gate", {
            jobId: job.jobId,
            capabilityId: gate.capabilityId,
            reasonCode: gate.reasonCode,
          });
          return;
        }
      }

      if (job.notBeforeMs > 0 && Date.now() < job.notBeforeMs) {
        const remainingDelayMs = Math.max(0, job.notBeforeMs - Date.now());
        if (remainingDelayMs > MAX_INLINE_NOT_BEFORE_WAIT_MS) {
          logger.debug("Outbound job remains pending until not-before deadline", {
            jobId: job.jobId,
            remainingDelayMs,
            notBeforeMs: job.notBeforeMs,
          });
          return;
        }

        await this.sleep(remainingDelayMs);
      }

      const claimState = await this.deliveryClaimStore.claim(
        job.jobId,
        claimToken,
        this.config.deliveryClaimTtlMs,
      );
      if (claimState === "completed") {
        await this.queue.ack("outbound", messageId);
        metrics.deliveryDuplicatesSkipped.inc({ domain: job.targetDomain });
        logger.debug("Completed duplicate delivery skipped", { jobId: job.jobId, activityId: job.activityId });
        return;
      }
      if (claimState === "in_flight") {
        await this.deferOrParkJob(job, {
          reason: "delivery_claim_in_flight",
          baseDelayMs: this.config.deliveryClaimTtlMs,
        });
        await this.queue.ack("outbound", messageId);
        logger.debug("Outbound delivery deferred behind an in-flight claim", { jobId: job.jobId });
        return;
      }
      claimHeld = true;

      if (await this.queue.isDomainBlocked(job.targetDomain)) {
        await this.deliveryClaimStore.release(job.jobId, claimToken);
        claimHeld = false;
        await this.queue.moveToDlq("outbound", job, "Domain blocked");
        await this.queue.ack("outbound", messageId);
        logger.info("Delivery to blocked domain skipped", { jobId: job.jobId, domain: job.targetDomain });
        return;
      }

      if (!await this.queue.checkDomainRateLimit(job.targetDomain)) {
        await this.deliveryClaimStore.release(job.jobId, claimToken);
        claimHeld = false;
        await this.deferOrParkJob(job, { reason: "domain_rate_limited", baseDelayMs: 5000 });
        await this.queue.ack("outbound", messageId);
        return;
      }

      if (!await this.queue.acquireDomainSlot(job.targetDomain, this.config.maxConcurrentPerDomain)) {
        await this.deliveryClaimStore.release(job.jobId, claimToken);
        claimHeld = false;
        await this.deferOrParkJob(job, { reason: "domain_concurrency_limit", baseDelayMs: 1000 });
        await this.queue.ack("outbound", messageId);
        return;
      }

      try {
        const finalQueueResidenceMs = typeof firstQueuedAtMs === "number"
          ? outboxIntentAgeMs(firstQueuedAtMs, Date.now())
          : syntheticDirectTestMessage
            ? 0
            : null;
        if (
          finalQueueResidenceMs === null
          || finalQueueResidenceMs > APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS
        ) {
          const reason = finalQueueResidenceMs === null
            ? "Outbound message is missing a valid preserved first-enqueue timestamp immediately before delivery"
            : `Outbound message exceeded the ${APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS} ms APDM queue residence limit immediately before delivery`;
          await this.deliveryClaimStore.release(job.jobId, claimToken);
          claimHeld = false;
          await this.queue.moveToDlq("outbound", { ...job, lastError: reason }, reason);
          await this.queue.ack("outbound", messageId);
          metrics.deliveryDlq.inc({ domain: job.targetDomain });
          metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "queue_expired" });
          logger.warn("Outbound delivery expired immediately before HTTP delivery", {
            jobId: job.jobId,
            activityId: job.activityId,
            firstQueuedAtMs,
            queueResidenceMs: finalQueueResidenceMs,
            maxQueueResidenceMs: APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
          });
          return;
        }

        const result = await this.deliver(job);

        if (result.success) {
          try {
            await this.deliveryClaimStore.complete(
              job.jobId,
              claimToken,
              this.config.deliveryCompletedTtlMs,
            );
            claimHeld = false;
          } catch (error: any) {
            logger.error("Remote delivery succeeded but completed marker could not be persisted", {
              jobId: job.jobId,
              error: sanitizeErrorText(error?.message ?? error),
            });
            return;
          }

          await this.queue.ack("outbound", messageId);
          metrics.deliverySuccess.inc({ domain: job.targetDomain });
          metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "success" });
          metrics.deliveryLatency.observe(
            { domain: job.targetDomain, type: "outbound", status: "success" },
            (Date.now() - deliveryStartedAt) / 1000,
          );
          await this.callAdapter("onOutboundDelivered", {
            actorUri: job.actorUri,
            activityId: job.activityId,
            targetDomain: job.targetDomain,
            statusCode: result.statusCode,
            meta: job.meta,
          });
          logger.info("Delivery successful", {
            jobId: job.jobId,
            activityId: job.activityId,
            target: job.targetInbox,
            statusCode: result.statusCode,
          });
        } else if (result.permanent) {
          await this.deliveryClaimStore.release(job.jobId, claimToken);
          claimHeld = false;
          await this.queue.moveToDlq("outbound", job, result.error || "Permanent failure");
          await this.queue.ack("outbound", messageId);
          metrics.deliveryDlq.inc({ domain: job.targetDomain });
          metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "permanent_failure" });
          metrics.deliveryLatency.observe(
            { domain: job.targetDomain, type: "outbound", status: "permanent_failure" },
            (Date.now() - deliveryStartedAt) / 1000,
          );
          await this.callAdapter("onOutboundPermanentFailure", {
            actorUri: job.actorUri,
            activityId: job.activityId,
            targetDomain: job.targetDomain,
            targetInbox: job.targetInbox,
            statusCode: result.statusCode,
            error: result.error || "Permanent failure",
            responseBody: result.responseBody,
            attempt: job.attempt + 1,
            meta: job.meta,
          });
          logger.warn("Permanent delivery failure", {
            jobId: job.jobId,
            error: result.error,
            statusCode: result.statusCode,
          });
        } else {
          await this.deliveryClaimStore.release(job.jobId, claimToken);
          claimHeld = false;
          metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "transient_failure" });
          metrics.deliveryLatency.observe(
            { domain: job.targetDomain, type: "outbound", status: "transient_failure" },
            (Date.now() - deliveryStartedAt) / 1000,
          );

          const nextAttempt = job.attempt + 1;
          if (nextAttempt >= job.maxAttempts) {
            await this.queue.moveToDlq("outbound", { ...job, lastError: result.error }, "Max attempts exceeded");
            await this.queue.ack("outbound", messageId);
            metrics.deliveryDlq.inc({ domain: job.targetDomain });
            await this.callAdapter("onOutboundPermanentFailure", {
              actorUri: job.actorUri,
              activityId: job.activityId,
              targetDomain: job.targetDomain,
              targetInbox: job.targetInbox,
              statusCode: result.statusCode,
              error: result.error || "Max attempts exceeded",
              responseBody: result.responseBody,
              attempt: nextAttempt,
              meta: job.meta,
            });
            logger.warn("Max delivery attempts exceeded", {
              jobId: job.jobId,
              attempts: nextAttempt,
              lastError: result.error,
            });
          } else {
            const delay = result.retryAfterMs != null
              ? Math.max(backoffMs(nextAttempt), result.retryAfterMs)
              : backoffMs(nextAttempt);
            const retryJob: OutboundJob = {
              ...job,
              attempt: nextAttempt,
              notBeforeMs: Date.now() + delay,
              lastError: result.error,
            };
            await this.queue.enqueueOutbound(retryJob);
            await this.queue.ack("outbound", messageId);
            metrics.deliveryRetries.inc({ domain: job.targetDomain });
            logger.info("Delivery failed, scheduled retry", {
              jobId: job.jobId,
              attempt: nextAttempt,
              retryAt: new Date(retryJob.notBeforeMs).toISOString(),
              error: sanitizeErrorText(result.error),
            });
          }
        }
      } finally {
        await this.queue.releaseDomainSlot(job.targetDomain);
      }
    } catch (err: any) {
      const sanitized = sanitizeErrorText(err?.message ?? err);
      logger.error("Error processing outbound job", { jobId: job.jobId, error: sanitized });
      if (claimHeld) {
        await this.deliveryClaimStore.release(job.jobId, claimToken).catch(() => undefined);
        claimHeld = false;
      }

      await this.queue.moveToDlq(
        "outbound",
        { ...job, lastError: sanitized },
        `Worker processing error: ${sanitized}`,
      );
      metrics.deliveryDlq.inc({ domain: job.targetDomain });
      await this.queue.ack("outbound", messageId);
    } finally {
      this.activeJobs--;
    }
  }

  /** Deliver an activity to a remote inbox. */
  protected async deliver(job: OutboundJob): Promise<DeliveryResult> {
    if (!isSafeTargetInboxUrl(job.targetInbox)) {
      return {
        jobId: job.jobId,
        success: false,
        error: `Unsafe target inbox URL rejected: ${job.targetInbox}`,
        permanent: true,
      };
    }

    if (this.adapter.enabled && this.adapter.deliverOutbound) {
      return await this.adapter.deliverOutbound({
        jobId: job.jobId,
        actorUri: job.actorUri,
        activityId: job.activityId,
        activity: job.activity,
        targetInbox: job.targetInbox,
        targetDomain: job.targetDomain,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        requestTimeoutMs: this.config.requestTimeoutMs,
        userAgent: this.config.userAgent,
        assertExternalPostAllowed: () => this.assertExternalPostAllowed(job),
        signHttpRequest: async ({ actorUri, method, targetUrl, body }) => {
          const signResult = await this.signingClient.signOne({ actorUri, method, targetUrl, body });
          if (!signResult.ok) {
            const errorResult = signResult as SignErrorResult;
            return {
              ok: false as const,
              error: {
                code: errorResult.error.code,
                message: errorResult.error.message,
                permanent: SigningClient.isPermanentError(errorResult),
              },
            };
          }

          return {
            ok: true as const,
            signedHeaders: {
              date: signResult.signedHeaders.date,
              digest: signResult.signedHeaders.digest,
              signature: signResult.signedHeaders.signature,
            },
          };
        },
      });
    }

    const targetUrl = new URL(job.targetInbox);
    const signResult = await this.signingClient.signOne({
      actorUri: job.actorUri,
      method: "POST",
      targetUrl: job.targetInbox,
      body: job.activity,
    });

    if (!signResult.ok) {
      const errorResult = signResult as SignErrorResult;
      return {
        jobId: job.jobId,
        success: false,
        error: `Signing failed: ${errorResult.error.code} - ${errorResult.error.message}`,
        permanent: SigningClient.isPermanentError(errorResult),
      };
    }

    const successResult = signResult as { ok: true; signedHeaders: { date: string; digest?: string; signature: string } };

    try {
      const headers: Record<string, string> = {
        "content-type": "application/activity+json",
        "accept": "application/activity+json, application/ld+json",
        "user-agent": this.config.userAgent,
        "date": successResult.signedHeaders.date,
        "signature": successResult.signedHeaders.signature,
        "host": targetUrl.host,
      };

      if (successResult.signedHeaders.digest) {
        headers["digest"] = successResult.signedHeaders.digest;
      }

      if (this.followersSyncService && job.meta?.visibility === "followers" && this.config.domain) {
        const actorIdentifier = extractActorIdentifier(job.actorUri, this.config.domain);
        if (actorIdentifier) {
          const followersUri = `${job.actorUri}/followers`;
          const syncHeaderValue = await this.followersSyncService.buildSenderHeader(
            actorIdentifier,
            followersUri,
            job.targetInbox,
          ).catch(() => null);
          if (syncHeaderValue) headers[COLLECTION_SYNC_HEADER] = syncHeaderValue;
        }
      }

      this.assertExternalPostAllowed(job);
      const response = await request(job.targetInbox, {
        method: "POST",
        headers,
        body: job.activity,
        bodyTimeout: this.config.requestTimeoutMs,
        headersTimeout: this.config.requestTimeoutMs,
        maxRedirections: 0,
      });

      const statusCode = response.statusCode;
      const retryAfterMs = parseRetryAfterMs(
        typeof response.headers["retry-after"] === "string"
          ? response.headers["retry-after"]
          : Array.isArray(response.headers["retry-after"])
            ? response.headers["retry-after"][0]
            : undefined,
      );
      const responseBody = sanitizeResponseBodySnippet(await response.body.text());

      if (statusCode >= 200 && statusCode < 300) {
        return { jobId: job.jobId, success: true, statusCode };
      }

      if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
        return {
          jobId: job.jobId,
          success: false,
          statusCode,
          error: `HTTP ${statusCode}`,
          responseBody,
          permanent: true,
        };
      }

      return {
        jobId: job.jobId,
        success: false,
        statusCode,
        error: `HTTP ${statusCode}`,
        responseBody,
        retryAfterMs,
        permanent: false,
      };
    } catch (err: any) {
      if (err instanceof OutboundResidenceExpiredError) throw err;
      return {
        jobId: job.jobId,
        success: false,
        error: `Network error: ${sanitizeErrorText(err?.message ?? err)}`,
        permanent: false,
      };
    }
  }

  private assertExternalPostAllowed(job: OutboundJob): void {
    const firstQueuedAtMs = job.meta?.apdmFirstQueuedAtMs;
    const syntheticDirectTestJob = process.env["NODE_ENV"] === "test" && firstQueuedAtMs == null;
    const residenceMs = typeof firstQueuedAtMs === "number"
      ? outboxIntentAgeMs(firstQueuedAtMs, Date.now())
      : syntheticDirectTestJob
        ? 0
        : null;
    if (residenceMs === null || residenceMs > APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS) {
      const reason = residenceMs === null
        ? "Outbound message is missing a valid preserved first-enqueue timestamp at external POST boundary"
        : `Outbound message exceeded the ${APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS} ms APDM queue residence limit at external POST boundary`;
      throw new OutboundResidenceExpiredError(reason);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async deferOrParkJob(
    job: OutboundJob,
    options: { reason: string; baseDelayMs: number },
  ): Promise<void> {
    const nextDeferCount = (job.deferCount ?? 0) + 1;

    if (nextDeferCount > this.config.notReadyMaxRequeues) {
      await this.queue.moveToDlq(
        "outbound",
        {
          ...job,
          deferCount: nextDeferCount,
          lastError: `Deferred too many times (${options.reason})`,
        },
        `Deferred requeue limit exceeded: ${options.reason}`,
      );
      metrics.deliveryDlq.inc({ domain: job.targetDomain });
      metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "deferred_exhausted" });
      logger.warn("Outbound job parked in DLQ after excessive deferrals", {
        jobId: job.jobId,
        domain: job.targetDomain,
        reason: options.reason,
        deferCount: nextDeferCount,
        maxDeferCount: this.config.notReadyMaxRequeues,
      });
      return;
    }

    const jitterMs = this.config.notReadyJitterMs > 0
      ? Math.floor(Math.random() * this.config.notReadyJitterMs)
      : 0;
    const delayMs = Math.max(options.baseDelayMs, this.config.notReadyMinDelayMs) + jitterMs;
    const nextNotBeforeMs = Date.now() + delayMs;

    await this.queue.enqueueOutbound({
      ...job,
      deferCount: nextDeferCount,
      notBeforeMs: nextNotBeforeMs,
      lastError: `Deferred (${options.reason})`,
    });

    metrics.deliveryRetries.inc({ domain: job.targetDomain });
    logger.debug("Outbound job deferred", {
      jobId: job.jobId,
      domain: job.targetDomain,
      reason: options.reason,
      deferCount: nextDeferCount,
      deferUntil: new Date(nextNotBeforeMs).toISOString(),
      delayMs,
    });
  }

  private startTelemetryLoop(): void {
    if (this.config.queueTelemetryIntervalMs <= 0 || this.telemetryTimer) return;
    this.telemetryTimer = setInterval(() => {
      void this.emitQueueTelemetry();
    }, this.config.queueTelemetryIntervalMs);
    this.telemetryTimer.unref?.();
  }

  private async emitQueueTelemetry(): Promise<void> {
    try {
      const [outboundPending, outboundLength] = await Promise.all([
        this.queue.getPendingCount("outbound"),
        this.queue.getStreamLength("outbound"),
      ]);
      metrics.queueDepth.set({ topic: "outbound" }, outboundLength);

      const heapUsedMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
      if (heapUsedMb >= this.config.heapWarnMb) {
        logger.warn("Outbound worker heap usage is high", {
          heapUsedMb,
          heapWarnMb: this.config.heapWarnMb,
          outboundPending,
          outboundLength,
          activeJobs: this.activeJobs,
        });
      } else {
        logger.info("Outbound queue telemetry", {
          outboundPending,
          outboundLength,
          activeJobs: this.activeJobs,
          heapUsedMb,
        });
      }
    } catch (error: any) {
      logger.debug("Outbound queue telemetry failed", { error: sanitizeErrorText(error?.message ?? error) });
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createOutboundWorker(
  queue: RedisStreamsQueue,
  signingClient: SigningClient,
  redpanda: RedPandaProducer,
  overrides?: Partial<OutboundWorkerConfig>
): OutboundWorker {
  const config: OutboundWorkerConfig = {
    concurrency: parsePositiveIntEnv("OUTBOUND_CONCURRENCY", 64),
    maxConcurrentPerDomain: parsePositiveIntEnv("MAX_CONCURRENT_PER_DOMAIN", 10),
    requestTimeoutMs: parsePositiveIntEnv("REQUEST_TIMEOUT_MS", 30000),
    userAgent: process.env["USER_AGENT"] || "Fedify-Sidecar/1.0 (ActivityPods)",
    notReadyMaxRequeues: parsePositiveIntEnv("OUTBOUND_NOT_READY_MAX_REQUEUES", 32),
    notReadyMinDelayMs: parsePositiveIntEnv("OUTBOUND_NOT_READY_MIN_DELAY_MS", 500),
    notReadyJitterMs: parseNonNegativeIntEnv("OUTBOUND_NOT_READY_JITTER_MS", 250),
    queueTelemetryIntervalMs: parsePositiveIntEnv("OUTBOUND_TELEMETRY_INTERVAL_MS", 15000),
    heapWarnMb: parsePositiveIntEnv("OUTBOUND_HEAP_WARN_MB", 1024),
    deliveryClaimTtlMs: parsePositiveIntEnv("OUTBOUND_DELIVERY_CLAIM_TTL_MS", 120000),
    deliveryCompletedTtlMs: parsePositiveIntEnv("OUTBOUND_DELIVERY_COMPLETED_TTL_MS", 86400000),
    fedifyRuntimeIntegrationEnabled: process.env["ENABLE_FEDIFY_RUNTIME_INTEGRATION"] === "true",
    domain: process.env["DOMAIN"],
    ...overrides,
  };

  return new OutboundWorker(queue, signingClient, redpanda, config);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
