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
import { 
  RedisStreamsQueue, 
  OutboundJob, 
  backoffMs,
} from "../queue/sidecar-redis-queue.js";
import { SigningClient, SignResult, SignErrorResult } from "../signing/signing-client.js";
import { RedPandaProducer } from "../streams/redpanda-producer.js";
import { logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface OutboundWorkerConfig {
  concurrency: number;
  maxConcurrentPerDomain: number;
  requestTimeoutMs: number;
  userAgent: string;
}

export interface DeliveryResult {
  jobId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  permanent?: boolean;  // If true, don't retry
}

// ============================================================================
// Outbound Worker
// ============================================================================

export class OutboundWorker {
  private queue: RedisStreamsQueue;
  private signingClient: SigningClient;
  private redpanda: RedPandaProducer;
  private config: OutboundWorkerConfig;
  private isRunning = false;
  private activeJobs = 0;

  constructor(
    queue: RedisStreamsQueue,
    signingClient: SigningClient,
    redpanda: RedPandaProducer,
    config: OutboundWorkerConfig
  ) {
    this.queue = queue;
    this.signingClient = signingClient;
    this.redpanda = redpanda;
    this.config = config;
  }

  /**
   * Start the worker loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Outbound worker started", { concurrency: this.config.concurrency });

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
    
    // Wait for active jobs to complete (with timeout)
    const timeout = Date.now() + 30000;
    while (this.activeJobs > 0 && Date.now() < timeout) {
      await this.sleep(100);
    }
    
    logger.info("Outbound worker stopped", { remainingJobs: this.activeJobs });
  }

  /**
   * Process a single delivery job
   */
  private async processJob(messageId: string, job: OutboundJob): Promise<void> {
    this.activeJobs++;
    
    try {
      // Step 1: Check notBeforeMs (delayed job)
      if (job.notBeforeMs > 0 && Date.now() < job.notBeforeMs) {
        // Not ready yet - requeue without incrementing attempt
        await this.queue.ack("outbound", messageId);
        await this.queue.enqueueOutbound(job);
        logger.debug("Job not ready, requeued", { jobId: job.jobId, notBefore: new Date(job.notBeforeMs).toISOString() });
        return;
      }

      // Step 2: Check idempotency (have we already delivered this?)
      const isNew = await this.queue.checkIdempotency(job);
      if (!isNew) {
        // Already delivered - ack and skip
        await this.queue.ack("outbound", messageId);
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
      if (!await this.queue.checkDomainRateLimit(job.targetDomain)) {
        // Rate limited - requeue with short delay
        await this.queue.ack("outbound", messageId);
        await this.queue.clearIdempotency(job);  // Clear since we didn't actually send
        const delayedJob = { ...job, notBeforeMs: Date.now() + 5000 };
        await this.queue.enqueueOutbound(delayedJob);
        logger.debug("Domain rate limited, delayed", { jobId: job.jobId, domain: job.targetDomain });
        return;
      }

      // Step 5: Acquire domain concurrency slot
      if (!await this.queue.acquireDomainSlot(job.targetDomain)) {
        // At concurrency limit - requeue with short delay
        await this.queue.ack("outbound", messageId);
        await this.queue.clearIdempotency(job);
        const delayedJob = { ...job, notBeforeMs: Date.now() + 1000 };
        await this.queue.enqueueOutbound(delayedJob);
        logger.debug("Domain at concurrency limit, delayed", { jobId: job.jobId, domain: job.targetDomain });
        return;
      }

      try {
        // Step 6: Deliver the activity
        const result = await this.deliver(job);

        // Step 7: Handle result
        if (result.success) {
          // Success - ack and we're done
          await this.queue.ack("outbound", messageId);
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
          logger.warn("Permanent delivery failure", { 
            jobId: job.jobId, 
            error: result.error,
            statusCode: result.statusCode,
          });
        } else {
          // Transient failure - retry or DLQ
          await this.queue.ack("outbound", messageId);
          await this.queue.clearIdempotency(job);  // Clear since we didn't successfully deliver
          
          const nextAttempt = job.attempt + 1;
          if (nextAttempt >= job.maxAttempts) {
            // Max attempts reached - DLQ
            await this.queue.moveToDlq("outbound", { ...job, lastError: result.error }, "Max attempts exceeded");
            logger.warn("Max delivery attempts exceeded", { 
              jobId: job.jobId, 
              attempts: nextAttempt,
              lastError: result.error,
            });
          } else {
            // Requeue with backoff
            const delay = backoffMs(nextAttempt);
            const retryJob: OutboundJob = {
              ...job,
              attempt: nextAttempt,
              notBeforeMs: Date.now() + delay,
              lastError: result.error,
            };
            await this.queue.enqueueOutbound(retryJob);
            logger.info("Delivery failed, scheduled retry", { 
              jobId: job.jobId, 
              attempt: nextAttempt,
              retryAt: new Date(retryJob.notBeforeMs).toISOString(),
              error: result.error,
            });
          }
        }
      } finally {
        // Always release domain slot
        await this.queue.releaseDomainSlot(job.targetDomain);
      }

    } catch (err: any) {
      logger.error("Error processing outbound job", { jobId: job.jobId, error: err.message });
      // On unexpected error, ack to prevent infinite reprocessing
      // The job will be in an inconsistent state, but that's better than a loop
      await this.queue.ack("outbound", messageId);
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Deliver an activity to a remote inbox
   */
  private async deliver(job: OutboundJob): Promise<DeliveryResult> {
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

      const response = await request(job.targetInbox, {
        method: "POST",
        headers,
        body: job.activity,  // Send the exact bytes that were signed
        bodyTimeout: this.config.requestTimeoutMs,
        headersTimeout: this.config.requestTimeoutMs,
      });

      const statusCode = response.statusCode;

      // Consume body to release connection
      await response.body.text();

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
          permanent: true,
        };
      }

      // Transient failures: 5xx, 408, 429
      return {
        jobId: job.jobId,
        success: false,
        statusCode,
        error: `HTTP ${statusCode}`,
        permanent: false,
      };

    } catch (err: any) {
      // Network errors are transient
      return {
        jobId: job.jobId,
        success: false,
        error: `Network error: ${err.message}`,
        permanent: false,
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    concurrency: parseInt(process.env.OUTBOUND_CONCURRENCY || "64", 10),
    maxConcurrentPerDomain: parseInt(process.env.MAX_CONCURRENT_PER_DOMAIN || "10", 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10),
    userAgent: process.env.USER_AGENT || "Fedify-Sidecar/1.0 (ActivityPods)",
    ...overrides,
  };

  return new OutboundWorker(queue, signingClient, redpanda, config);
}
