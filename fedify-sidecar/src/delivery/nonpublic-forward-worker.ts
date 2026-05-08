import { request } from "undici";
import {
  RedisStreamsQueue,
  type NonPublicForwardJob,
  backoffMs,
} from "../queue/sidecar-redis-queue.js";
import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";

export interface NonPublicForwardWorkerConfig {
  concurrency: number;
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs: number;
  maxActivityBytes: number;
  /** Drop jobs older than this (ms since createdAt). Prevents zombie redelivery of stale private content. */
  maxJobAgeMs: number;
  /** Cap deferred-wait sleep before re-enqueueing a not-yet-due job (ms). */
  deferSleepCapMs: number;
}

class NonPublicForwardProcessingError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
  ) {
    super(message);
    this.name = "NonPublicForwardProcessingError";
  }
}

export class NonPublicForwardWorker {
  private readonly queue: RedisStreamsQueue;
  private readonly config: NonPublicForwardWorkerConfig;
  private isRunning = false;
  private activeJobs = 0;

  constructor(queue: RedisStreamsQueue, config: NonPublicForwardWorkerConfig) {
    this.queue = queue;
    this.config = config;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Non-public forward worker started", {
      concurrency: this.config.concurrency,
    });

    for await (const { messageId, job } of this.queue.consumeNonPublicForwards()) {
      if (!this.isRunning) break;

      while (this.activeJobs >= this.config.concurrency) {
        await this.sleep(100);
      }

      this.processJob(messageId, job).catch((error: Error) => {
        logger.error("Unhandled error in non-public forward processing", {
          jobId: job.jobId,
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

    logger.info("Non-public forward worker stopped", { remainingJobs: this.activeJobs });
  }

  protected async processJob(messageId: string, job: NonPublicForwardJob): Promise<void> {
    this.activeJobs++;

    try {
      // Stale-job guard — drop ancient jobs to DLQ rather than retrying indefinitely
      // against a stale private payload (privacy + storage hygiene).
      if (
        this.config.maxJobAgeMs > 0 &&
        Date.now() - job.createdAt > this.config.maxJobAgeMs
      ) {
        await this.queue.moveToDlq(
          "nonpublic_forward",
          { ...job, lastError: "stale: exceeded maxJobAgeMs" },
          `Dropped stale non-public forward (age > ${this.config.maxJobAgeMs}ms)`,
        );
        await this.queue.ack("nonpublic_forward", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "dlq" });
        logger.warn("Non-public forward dropped as stale", {
          jobId: job.jobId,
          ageMs: Date.now() - job.createdAt,
          maxJobAgeMs: this.config.maxJobAgeMs,
        });
        return;
      }

      if (job.notBeforeMs > 0 && Date.now() < job.notBeforeMs) {
        // Sleep up to deferSleepCapMs in-process so a small backoff doesn't
        // become a tight ack→re-enqueue→re-read busy loop. For longer waits
        // we still re-enqueue to keep the worker responsive to other jobs.
        const waitMs = job.notBeforeMs - Date.now();
        if (waitMs <= this.config.deferSleepCapMs) {
          await this.sleep(waitMs);
          // fall through to processing below
        } else {
          // Re-enqueue first, then ack — guarantees no message loss if the
          // process crashes between the two operations.
          await this.queue.enqueueNonPublicForward(job);
          await this.queue.ack("nonpublic_forward", messageId);
          metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "deferred" });
          return;
        }
      }

      this.validateJob(job);

      const forwardResult = await this.forwardToActivityPods(job);
      if (forwardResult.success) {
        await this.queue.ack("nonpublic_forward", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "success" });
        metrics.queueProcessingLatency.observe(
          { topic: "nonpublic_forward" },
          Math.max(0, (Date.now() - job.createdAt) / 1000),
        );
        return;
      }

      const nextAttempt = job.attempt + 1;
      if (forwardResult.permanent || nextAttempt >= job.maxAttempts) {
        // Move to DLQ first, then ack — preserves at-least-once semantics
        // on the DLQ side if we crash mid-handler.
        await this.queue.moveToDlq(
          "nonpublic_forward",
          {
            ...job,
            attempt: nextAttempt,
            lastError: forwardResult.error,
          },
          forwardResult.permanent
            ? (forwardResult.error || "forward failed (permanent)")
            : `Exhausted ${job.maxAttempts} attempts: ${forwardResult.error || "forward failed"}`,
        );
        await this.queue.ack("nonpublic_forward", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "dlq" });
        logger.warn("Non-public forward moved to DLQ", {
          jobId: job.jobId,
          attempt: nextAttempt,
          permanent: forwardResult.permanent,
          error: forwardResult.error,
        });
      } else {
        const delay = backoffMs(nextAttempt);
        await this.queue.enqueueNonPublicForward({
          ...job,
          attempt: nextAttempt,
          notBeforeMs: Date.now() + delay,
          lastError: forwardResult.error,
        });
        await this.queue.ack("nonpublic_forward", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "retry" });
        logger.warn("Non-public forward failed, scheduled retry", {
          jobId: job.jobId,
          attempt: nextAttempt,
          retryAt: new Date(Date.now() + delay).toISOString(),
          error: forwardResult.error,
        });
      }

      metrics.queueProcessingLatency.observe(
        { topic: "nonpublic_forward" },
        Math.max(0, (Date.now() - job.createdAt) / 1000),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof NonPublicForwardProcessingError
        ? error.permanent
        : false;

      const nextAttempt = job.attempt + 1;
      if (permanent || nextAttempt >= job.maxAttempts) {
        await this.queue.moveToDlq(
          "nonpublic_forward",
          {
            ...job,
            attempt: nextAttempt,
            lastError: message,
          },
          permanent ? message : "Max attempts exceeded",
        );
        await this.queue.ack("nonpublic_forward", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "dlq" });
      } else {
        const delay = backoffMs(nextAttempt);
        await this.queue.enqueueNonPublicForward({
          ...job,
          attempt: nextAttempt,
          notBeforeMs: Date.now() + delay,
          lastError: message,
        });
        await this.queue.ack("nonpublic_forward", messageId);
        metrics.queueMessagesProcessed.inc({ topic: "nonpublic_forward", status: "retry" });
      }

      metrics.queueProcessingLatency.observe(
        { topic: "nonpublic_forward" },
        Math.max(0, (Date.now() - job.createdAt) / 1000),
      );
    } finally {
      this.activeJobs--;
    }
  }

  private validateJob(job: NonPublicForwardJob): void {
    // Path safety: must be a relative inbox path with no traversal or scheme injection.
    // Prevents an attacker from steering forwards to an arbitrary URL by crafting the
    // inbound request's path.
    if (
      typeof job.path !== "string" ||
      !job.path.startsWith("/") ||
      job.path.startsWith("//") ||
      job.path.includes("..") ||
      job.path.includes("\\") ||
      /[\r\n]/.test(job.path) ||
      /^\/[a-z][a-z0-9+.-]*:/i.test(job.path)
    ) {
      throw new NonPublicForwardProcessingError("Invalid target inbox path", true);
    }

    if (Buffer.byteLength(job.activity, "utf8") > this.config.maxActivityBytes) {
      throw new NonPublicForwardProcessingError(
        `Activity payload exceeds configured size (${this.config.maxActivityBytes} bytes)`,
        true,
      );
    }

    try {
      const parsed = JSON.parse(job.activity) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new NonPublicForwardProcessingError("Activity payload must be a JSON object", true);
      }
    } catch (error) {
      if (error instanceof NonPublicForwardProcessingError) {
        throw error;
      }
      throw new NonPublicForwardProcessingError(
        `Activity payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  private async forwardToActivityPods(
    job: NonPublicForwardJob,
  ): Promise<{ success: boolean; permanent?: boolean; error?: string }> {
    try {
      const activity = JSON.parse(job.activity) as unknown;
      const targetInbox = `${this.config.activityPodsUrl}${job.path}`;
      const isBenchmark = job.headers["x-sidecar-benchmark"] === "1";

      const response = await request(
        `${this.config.activityPodsUrl}/api/internal/activitypub-bridge/inbox/receive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.activityPodsToken}`,
          },
          body: JSON.stringify({
            targetInbox,
            activity,
            verifiedActorUri: job.verifiedActorUri,
            receivedAt: job.receivedAt,
            remoteIp: job.remoteIp,
            benchmark: isBenchmark,
          }),
          bodyTimeout: this.config.requestTimeoutMs,
          headersTimeout: this.config.requestTimeoutMs,
        },
      );

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await response.body.text();
        return { success: true };
      }

      const body = await response.body.text();
      if (response.statusCode >= 400 && response.statusCode < 500 && response.statusCode !== 429) {
        return {
          success: false,
          permanent: true,
          error: `ActivityPods returned ${response.statusCode}: ${body}`,
        };
      }

      return {
        success: false,
        permanent: false,
        error: `ActivityPods returned ${response.statusCode}: ${body}`,
      };
    } catch (error: any) {
      return {
        success: false,
        permanent: false,
        error: `Network error: ${error.message}`,
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createNonPublicForwardWorker(
  queue: RedisStreamsQueue,
  overrides?: Partial<NonPublicForwardWorkerConfig>,
): NonPublicForwardWorker {
  const requestTimeoutMs = parseInt(
    process.env["NONPUBLIC_FORWARD_REQUEST_TIMEOUT_MS"] ||
      process.env["REQUEST_TIMEOUT_MS"] ||
      "30000",
    10,
  );

  const config: NonPublicForwardWorkerConfig = {
    concurrency: parseInt(process.env["NONPUBLIC_FORWARD_CONCURRENCY"] || "16", 10),
    activityPodsUrl: process.env["ACTIVITYPODS_URL"] || "http://localhost:3000",
    activityPodsToken: process.env["ACTIVITYPODS_TOKEN"] || "",
    requestTimeoutMs,
    maxActivityBytes: parseInt(process.env["NONPUBLIC_FORWARD_MAX_ACTIVITY_BYTES"] || `${512 * 1024}`, 10),
    maxJobAgeMs: parseInt(process.env["NONPUBLIC_FORWARD_MAX_AGE_MS"] || `${60 * 60 * 1000}`, 10),
    deferSleepCapMs: parseInt(process.env["NONPUBLIC_FORWARD_DEFER_SLEEP_CAP_MS"] || "1000", 10),
    ...overrides,
  };

  return new NonPublicForwardWorker(queue, config);
}
