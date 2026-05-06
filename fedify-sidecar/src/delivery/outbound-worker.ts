/**
 * Outbound Delivery Worker
 * 
 * Processes outbound delivery jobs from the Redis Streams queue.
 * Handles HTTP signature requests, delivery, retry logic, and dead-lettering.
 * 
 * Key principles:
 * - Idempotency check BEFORE processing
 * - Body is immutable (signed bytes = sent bytes)
 * - Domain rate limiting and concurrency control
 * - Exponential backoff with Mastodon-compatible tiers
 * - Shared inbox optimization
 */

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

// ============================================================================
// Types
// ============================================================================

export interface OutboundWorkerConfig {
  concurrency: number;
  maxConcurrentPerDomain: number;
  domainRateLimitMaxPerWindow?: number;
  domainRateLimitWindowSeconds?: number;
  requestTimeoutMs: number;
  userAgent: string;
  notReadyMaxRequeues?: number;
  notReadyMinDelayMs?: number;
  notReadyJitterMs?: number;
  queueTelemetryIntervalMs?: number;
  heapWarnMb?: number;
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
  domainRateLimitMaxPerWindow: number;
  domainRateLimitWindowSeconds: number;
};

export interface DeliveryResult extends OutboundDeliveryResult {}

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_ERROR_TEXT_LENGTH = 512;
const MAX_RESPONSE_BODY_LOG_LENGTH = 2048;

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
    this.config = {
      ...config,
      notReadyMaxRequeues: config.notReadyMaxRequeues ?? 32,
      notReadyMinDelayMs: config.notReadyMinDelayMs ?? 500,
      notReadyJitterMs: config.notReadyJitterMs ?? 250,
      queueTelemetryIntervalMs: config.queueTelemetryIntervalMs ?? 15000,
      heapWarnMb: config.heapWarnMb ?? 1024,
      domainRateLimitMaxPerWindow: config.domainRateLimitMaxPerWindow ?? 100,
      domainRateLimitWindowSeconds: config.domainRateLimitWindowSeconds ?? 60,
    } as NormalizedOutboundWorkerConfig;
    this.adapter = config.fedifyRuntimeIntegrationEnabled
      ? (config.adapter ?? NoopFederationRuntimeAdapter)
      : NoopFederationRuntimeAdapter;
    this.followersSyncService = config.followersSyncService ?? null;
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

  /**
   * Start the worker loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.startTelemetryLoop();
    logger.info("Outbound worker started", {
      concurrency: this.config.concurrency,
      domainRateLimitMaxPerWindow: this.config.domainRateLimitMaxPerWindow,
      domainRateLimitWindowSeconds: this.config.domainRateLimitWindowSeconds,
      fedifyRuntimeIntegrationEnabled: this.config.fedifyRuntimeIntegrationEnabled,
    });

    for await (const { messageId, job } of this.queue.consumeOutbound()) {
      if (!this.isRunning) break;

      // Respect concurrency limit
      while (this.activeJobs >= this.config.concurrency) {
        await this.sleep(100);
      }

      // Process job (don't await - run concurrently)
      this.processJob(messageId, job).catch(err => {
        logger.error("Unhandled error in job processing", { jobId: job.jobId, error: err.message });
      });
    }
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    
    // Wait for active jobs to complete (with timeout)
    const timeout = Date.now() + 30000;
    while (this.activeJobs > 0 && Date.now() < timeout) {
      await this.sleep(100);
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
    logger.info("Outbound worker concurrency updated", {
      previous,
      next: normalized,
    });
  }

  getMaxConcurrentPerDomain(): number {
    return this.config.maxConcurrentPerDomain;
  }

  setMaxConcurrentPerDomain(nextLimit: number): void {
    const normalized = Math.max(1, Math.floor(nextLimit));
    if (normalized === this.config.maxConcurrentPerDomain) return;

    const previous = this.config.maxConcurrentPerDomain;
    this.config.maxConcurrentPerDomain = normalized;
    logger.info("Outbound per-domain concurrency updated", {
      previous,
      next: normalized,
    });
  }

  /**
   * Process a single delivery job
   */
  protected async processJob(messageId: string, job: OutboundJob): Promise<void> {
    this.activeJobs++;
    const deliveryStartedAt = Date.now();
    
    try {
      if (this.config.capabilityGate) {
        const gate = this.config.capabilityGate("ap.federation.egress");
        if (!gate.allowed) {
          await this.queue.ack("outbound", messageId);
          await this.queue.moveToDlq(
            "outbound",
            job,
            gate.message || `Capability denied: ${gate.reasonCode || "feature_disabled"}`,
          );
          logger.warn("Outbound delivery skipped by capability gate", {
            jobId: job.jobId,
            capabilityId: gate.capabilityId,
            reasonCode: gate.reasonCode,
          });
          return;
        }
      }

      // Step 1: Check notBeforeMs (delayed job)
      if (job.notBeforeMs > 0 && Date.now() < job.notBeforeMs) {
        await this.queue.ack("outbound", messageId);
        const remainingDelayMs = Math.max(0, job.notBeforeMs - Date.now());
        await this.deferOrParkJob(job, {
          reason: "not_ready",
          baseDelayMs: Math.max(remainingDelayMs, this.config.notReadyMinDelayMs),
        });
        return;
      }

      // Step 2: Check idempotency (have we already delivered this?)
      const isNew = await this.queue.checkIdempotency(job);
      if (!isNew) {
        // Already delivered - ack and skip
        await this.queue.ack("outbound", messageId);
        metrics.deliveryDuplicatesSkipped.inc({ domain: job.targetDomain });
        logger.debug("Duplicate delivery skipped", { jobId: job.jobId, activityId: job.activityId });
        return;
      }

      // Step 3: Check domain blocklist
      if (await this.queue.isDomainBlocked(job.targetDomain)) {
        await this.queue.ack("outbound", messageId);
        await this.queue.moveToDlq("outbound", job, "Domain blocked");
        logger.info("Delivery to blocked domain skipped", { jobId: job.jobId, domain: job.targetDomain });
        return;
      }

      // Step 4: Check domain rate limit
      if (!await this.queue.checkDomainRateLimit(
        job.targetDomain,
        this.config.domainRateLimitMaxPerWindow,
        this.config.domainRateLimitWindowSeconds,
      )) {
        // Rate limited - requeue with short delay
        await this.queue.ack("outbound", messageId);
        await this.queue.clearIdempotency(job);  // Clear since we didn't actually send
        await this.deferOrParkJob(job, {
          reason: "domain_rate_limited",
          baseDelayMs: 5000,
        });
        return;
      }

      // Step 5: Acquire domain concurrency slot
      if (!await this.queue.acquireDomainSlot(job.targetDomain, this.config.maxConcurrentPerDomain)) {
        // At concurrency limit - requeue with short delay
        await this.queue.ack("outbound", messageId);
        await this.queue.clearIdempotency(job);
        await this.deferOrParkJob(job, {
          reason: "domain_concurrency_limit",
          baseDelayMs: 1000,
        });
        return;
      }

      try {
        // Step 6: Deliver the activity
        const result = await this.deliver(job);

        // Step 7: Handle result
        if (result.success) {
          // Success - ack and notify integration adapter
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
          // Permanent failure - ack and DLQ
          await this.queue.ack("outbound", messageId);
          await this.queue.moveToDlq("outbound", job, result.error || "Permanent failure");
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
          // Transient failure - retry or DLQ
          await this.queue.ack("outbound", messageId);
          await this.queue.clearIdempotency(job);  // Clear since we didn't successfully deliver
          metrics.deliveriesTotal.inc({ domain: job.targetDomain, type: "outbound", status: "transient_failure" });
          metrics.deliveryLatency.observe(
            { domain: job.targetDomain, type: "outbound", status: "transient_failure" },
            (Date.now() - deliveryStartedAt) / 1000,
          );
          
          const nextAttempt = job.attempt + 1;
          if (nextAttempt >= job.maxAttempts) {
            // Max attempts reached - DLQ
            await this.queue.moveToDlq("outbound", { ...job, lastError: result.error }, "Max attempts exceeded");
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
            // Requeue with backoff
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
        // Always release domain slot
        await this.queue.releaseDomainSlot(job.targetDomain);
      }

    } catch (err: any) {
      const sanitized = sanitizeErrorText(err?.message ?? err);
      logger.error("Error processing outbound job", { jobId: job.jobId, error: sanitized });
      try {
        await this.queue.moveToDlq(
          "outbound",
          { ...job, lastError: sanitized },
          `Worker processing error: ${sanitized}`,
        );
        metrics.deliveryDlq.inc({ domain: job.targetDomain });
      } finally {
        // Ack even if DLQ insertion fails, to prevent infinite poison-message loops.
        await this.queue.ack("outbound", messageId);
      }
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Deliver an activity to a remote inbox
   */
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
        signHttpRequest: async ({ actorUri, method, targetUrl, body }) => {
          const signResult = await this.signingClient.signOne({
            actorUri,
            method,
            targetUrl,
            body,
          });
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

    // Step 1: Request signature from ActivityPods
    const targetUrl = new URL(job.targetInbox);
    
    const signResult = await this.signingClient.signOne({
      actorUri: job.actorUri,
      method: "POST",
      targetUrl: job.targetInbox,
      body: job.activity,  // Immutable - signed as-is
    });

    if (!signResult.ok) {
      const errorResult = signResult as SignErrorResult;
      const isPermanent = SigningClient.isPermanentError(errorResult);
      return {
        jobId: job.jobId,
        success: false,
        error: `Signing failed: ${errorResult.error.code} - ${errorResult.error.message}`,
        permanent: isPermanent,
      };
    }

    const successResult = signResult as { ok: true; signedHeaders: { date: string; digest?: string; signature: string } };

    // Step 2: Send the HTTP request
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

      // FEP-8fcf: add Collection-Synchronization header for follower-addressed
      // activities when the sync service is configured.
      if (
        this.followersSyncService &&
        job.meta?.visibility === "followers" &&
        this.config.domain
      ) {
        const actorIdentifier = extractActorIdentifier(job.actorUri, this.config.domain);
        if (actorIdentifier) {
          const followersUri = `${job.actorUri}/followers`;
          const syncHeaderValue = await this.followersSyncService.buildSenderHeader(
            actorIdentifier,
            followersUri,
            job.targetInbox,
          ).catch(() => null);
          if (syncHeaderValue) {
            headers[COLLECTION_SYNC_HEADER] = syncHeaderValue;
          }
        }
      }

      const response = await request(job.targetInbox, {
        method: "POST",
        headers,
        body: job.activity,  // Send the exact bytes that were signed
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

      // Consume body to release connection
      const responseBody = sanitizeResponseBodySnippet(await response.body.text());

      // Success: 2xx status codes
      if (statusCode >= 200 && statusCode < 300) {
        return {
          jobId: job.jobId,
          success: true,
          statusCode,
        };
      }

      // Permanent failures: 4xx (except 408, 429)
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

      // Transient failures: 5xx, 408, 429
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
      // Network errors are transient
      return {
        jobId: job.jobId,
        success: false,
        error: `Network error: ${sanitizeErrorText(err?.message ?? err)}`,
        permanent: false,
      };
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
    if (this.config.queueTelemetryIntervalMs <= 0 || this.telemetryTimer) {
      return;
    }

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
      logger.debug("Outbound queue telemetry failed", {
        error: sanitizeErrorText(error?.message ?? error),
      });
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
    domainRateLimitMaxPerWindow: parsePositiveIntEnv("DOMAIN_RATE_LIMIT_MAX_PER_WINDOW", 100),
    domainRateLimitWindowSeconds: parsePositiveIntEnv("DOMAIN_RATE_LIMIT_WINDOW_SECONDS", 60),
    requestTimeoutMs: parsePositiveIntEnv("REQUEST_TIMEOUT_MS", 30000),
    userAgent: process.env["USER_AGENT"] || "Fedify-Sidecar/1.0 (ActivityPods)",
    notReadyMaxRequeues: parsePositiveIntEnv("OUTBOUND_NOT_READY_MAX_REQUEUES", 32),
    notReadyMinDelayMs: parsePositiveIntEnv("OUTBOUND_NOT_READY_MIN_DELAY_MS", 500),
    notReadyJitterMs: parseNonNegativeIntEnv("OUTBOUND_NOT_READY_JITTER_MS", 250),
    queueTelemetryIntervalMs: parsePositiveIntEnv("OUTBOUND_TELEMETRY_INTERVAL_MS", 15000),
    heapWarnMb: parsePositiveIntEnv("OUTBOUND_HEAP_WARN_MB", 1024),
    fedifyRuntimeIntegrationEnabled:
      process.env["ENABLE_FEDIFY_RUNTIME_INTEGRATION"] === "true",
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
