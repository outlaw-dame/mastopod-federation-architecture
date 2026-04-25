import { createHash, randomUUID } from "node:crypto";
import { request } from "undici";
import {
  createVerifiedInboundEnvelope,
  type OriginReconciliationJob,
  type RedisStreamsQueue,
} from "../queue/sidecar-redis-queue.js";
import type { SigningClient } from "../signing/signing-client.js";
import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";
import { extractAttributedTo } from "../federation/replies-backfill/RepliesBackfillService.js";

const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_JSON_RESPONSE_BYTES = 2_000_000;

export interface OriginReconciliationWorkerConfig {
  concurrency: number;
  signerActorUri: string;
  requestTimeoutMs: number;
  requestRetries: number;
  requestRetryBaseDelayMs: number;
  requestRetryMaxDelayMs: number;
  userAgent: string;
  perOriginConcurrency: number;
  perOriginBurstLimit: number;
  perOriginBurstWindowSeconds: number;
  maxUnchangedSuccesses: number;
  applyIdempotencyTtlSeconds: number;
}

type DetailedFetchResult =
  | { ok: true; body: Record<string, unknown>; fingerprint: string }
  | { ok: false; classification: "blocked" | "transient" | "not_found" | "gone" | "permanent"; statusCode?: number; error?: string };

export class OriginReconciliationWorker {
  private readonly queue: RedisStreamsQueue;
  private readonly signingClient: SigningClient;
  private readonly config: OriginReconciliationWorkerConfig;
  private isRunning = false;
  private activeJobs = 0;

  constructor(
    queue: RedisStreamsQueue,
    signingClient: SigningClient,
    config: OriginReconciliationWorkerConfig,
  ) {
    this.queue = queue;
    this.signingClient = signingClient;
    this.config = config;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Origin reconciliation worker started", {
      concurrency: this.config.concurrency,
      signerActorUri: this.config.signerActorUri,
    });

    for await (const { messageId, job } of this.queue.consumeOriginReconciliation()) {
      if (!this.isRunning) break;

      while (this.activeJobs >= this.config.concurrency) {
        await sleep(100);
      }

      this.processJob(messageId, job).catch((error: Error) => {
        logger.error("Unhandled error in origin reconciliation processing", {
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
      await sleep(100);
    }
    logger.info("Origin reconciliation worker stopped", { remainingJobs: this.activeJobs });
  }

  protected async processJob(messageId: string, job: OriginReconciliationJob): Promise<void> {
    this.activeJobs++;
    const startedAt = Date.now();
    let originHost = "unknown";

    try {
      originHost = new URL(job.originObjectUrl).host;

      if (job.notBeforeMs > 0 && Date.now() < job.notBeforeMs) {
        await this.queue.ack("origin_reconcile", messageId);
        await this.queue.enqueueOriginReconciliation(job);
        metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status: "deferred" });
        return;
      }

      if (Date.now() >= job.windowExpiresAt || job.attempt >= job.maxAttempts) {
        await this.queue.ack("origin_reconcile", messageId);
        metrics.originReconciliationJobsTotal.inc({ result: "window_closed", reason: job.reason });
        metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status: "expired" });
        return;
      }

      const rateAllowed = await this.queue.checkDomainRateLimit(
        `origin-reconcile:${originHost}`,
        this.config.perOriginBurstLimit,
        this.config.perOriginBurstWindowSeconds,
      );
      if (!rateAllowed) {
        await this.deferJob(messageId, job, 30_000, "rate_limited");
        metrics.originReconciliationHostBackoffTotal.inc({ origin_host: originHost, reason: "rate_limited" });
        return;
      }

      const acquiredSlot = await this.queue.acquireDomainSlot(
        `origin-reconcile:${originHost}`,
        this.config.perOriginConcurrency,
      );
      if (!acquiredSlot) {
        await this.deferJob(messageId, job, 15_000, "concurrency_limited");
        metrics.originReconciliationHostBackoffTotal.inc({ origin_host: originHost, reason: "concurrency_limited" });
        return;
      }

      try {
        const result = await this.fetchRemoteObject(job.originObjectUrl);
        metrics.originReconciliationFetchesTotal.inc({ origin_host: originHost, result: result.ok ? "success" : result.classification });

        if (!result.ok) {
          await this.handleFailedFetch(messageId, job, result, originHost);
          return;
        }

        if (job.lastFingerprint && job.lastFingerprint === result.fingerprint) {
          const unchangedSuccesses = job.unchangedSuccesses + 1;
          metrics.originReconciliationNoopTotal.inc({ origin_host: originHost });
          if (unchangedSuccesses >= this.config.maxUnchangedSuccesses) {
            await this.queue.ack("origin_reconcile", messageId);
            metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status: "stable" });
            metrics.originReconciliationJobsTotal.inc({ result: "stable", reason: job.reason });
            return;
          }

          await this.rescheduleJob(messageId, {
            ...job,
            unchangedSuccesses,
            attempt: job.attempt + 1,
            notBeforeMs: Date.now() + nextReconciliationDelayMs(job.attempt + 1),
            lastError: "",
          });
          return;
        }

        const applyKey = job.canonicalObjectId || job.originObjectUrl;
        const shouldApply = await this.queue.markOriginReconciliationApplied(
          applyKey,
          result.fingerprint,
          this.config.applyIdempotencyTtlSeconds,
        );

        if (shouldApply) {
          await this.enqueueSyntheticUpdate(job, result.body);
          metrics.originReconciliationChangedTotal.inc({ origin_host: originHost });
        } else {
          metrics.originReconciliationNoopTotal.inc({ origin_host: originHost });
        }

        await this.rescheduleJob(messageId, {
          ...job,
          attempt: job.attempt + 1,
          unchangedSuccesses: 0,
          notFoundCount: 0,
          lastFingerprint: result.fingerprint,
          notBeforeMs: Date.now() + nextReconciliationDelayMs(job.attempt + 1),
          lastError: "",
        });
      } finally {
        await this.queue.releaseDomainSlot(`origin-reconcile:${originHost}`);
      }
    } finally {
      metrics.originReconciliationFetchLatency.observe(
        { origin_host: originHost },
        Math.max(0, (Date.now() - startedAt) / 1000),
      );
      this.activeJobs--;
    }
  }

  private async handleFailedFetch(
    messageId: string,
    job: OriginReconciliationJob,
    result: Extract<DetailedFetchResult, { ok: false }>,
    originHost: string,
  ): Promise<void> {
    if (result.classification === "transient") {
      await this.rescheduleJob(messageId, {
        ...job,
        attempt: job.attempt + 1,
        notBeforeMs: Date.now() + nextTransientDelayMs(job.attempt + 1),
        lastError: result.error ?? result.classification,
      });
      return;
    }

    if (result.classification === "not_found") {
      const notFoundCount = job.notFoundCount + 1;
      if (notFoundCount < 2 && Date.now() + 120_000 < job.windowExpiresAt) {
        await this.rescheduleJob(messageId, {
          ...job,
          attempt: job.attempt + 1,
          notFoundCount,
          notBeforeMs: Date.now() + 120_000,
          lastError: "not_found",
        });
        return;
      }

      await this.queue.ack("origin_reconcile", messageId);
      metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status: "not_found" });
      metrics.originReconciliationJobsTotal.inc({ result: "not_found", reason: job.reason });
      return;
    }

    if (result.classification === "gone") {
      await this.queue.ack("origin_reconcile", messageId);
      metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status: "gone" });
      metrics.originReconciliationJobsTotal.inc({ result: "gone", reason: job.reason });
      return;
    }

    await this.queue.ack("origin_reconcile", messageId);
    await this.queue.moveToDlq("origin_reconcile", {
      ...job,
      attempt: job.attempt + 1,
      lastError: result.error ?? result.classification,
    }, result.error ?? result.classification);
    metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status: "dlq" });
    metrics.originReconciliationJobsTotal.inc({ result: "dlq", reason: job.reason });
    metrics.originReconciliationHostBackoffTotal.inc({ origin_host: originHost, reason: result.classification });
  }

  private async enqueueSyntheticUpdate(
    job: OriginReconciliationJob,
    object: Record<string, unknown>,
  ): Promise<void> {
    const actorUri = job.actorUriHint ?? extractAttributedTo(object);
    if (!actorUri) {
      logger.debug("[origin-reconcile] changed object missing actor hint, skipping synthetic update", {
        originObjectUrl: job.originObjectUrl,
      });
      return;
    }

    const objectType = typeof object["type"] === "string" ? object["type"] : null;
    const syntheticActivity = objectType === "Tombstone"
      ? {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Delete",
          id: `urn:origin-reconcile:${randomUUID()}`,
          actor: actorUri,
          object: job.originObjectUrl,
        }
      : {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Update",
          id: `urn:origin-reconcile:${randomUUID()}`,
          actor: actorUri,
          object,
        };

    const envelope = createVerifiedInboundEnvelope({
      path: "/inbox",
      body: JSON.stringify(syntheticActivity),
      remoteIp: "127.0.0.1",
      verifiedActorUri: actorUri,
      headers: {
        "content-type": "application/activity+json",
        "x-origin-reconciliation": "true",
      },
    });

    await this.queue.enqueueInbound(envelope);
  }

  private async deferJob(
    messageId: string,
    job: OriginReconciliationJob,
    delayMs: number,
    reason: string,
  ): Promise<void> {
    await this.rescheduleJob(messageId, {
      ...job,
      notBeforeMs: Date.now() + delayMs,
      lastError: reason,
    }, "deferred");
  }

  private async rescheduleJob(
    messageId: string,
    job: OriginReconciliationJob,
    status: "retry" | "deferred" = "retry",
  ): Promise<void> {
    await this.queue.ack("origin_reconcile", messageId);
    await this.queue.enqueueOriginReconciliation(job);
    metrics.queueMessagesProcessed.inc({ topic: "origin_reconcile", status });
  }

  private async fetchRemoteObject(url: string): Promise<DetailedFetchResult> {
    if (!isAllowedRemoteFetchUrl(url)) {
      return { ok: false, classification: "blocked", error: "blocked unsafe fetch URL" };
    }

    const maxAttempts = Math.max(1, this.config.requestRetries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const signResult = await this.signingClient.signOne({
          actorUri: this.config.signerActorUri,
          method: "GET",
          targetUrl: url,
        });

        if (!signResult.ok) {
          return {
            ok: false,
            classification: "permanent",
            error: (signResult as { ok: false; error: { message: string } }).error.message,
          };
        }

        const parsedUrl = new URL(url);
        const { date, signature } = signResult.signedHeaders;
        const response = await request(url, {
          method: "GET",
          headers: {
            accept: "application/activity+json, application/ld+json",
            date,
            signature,
            host: parsedUrl.host,
            "user-agent": this.config.userAgent,
          },
          bodyTimeout: this.config.requestTimeoutMs,
          headersTimeout: this.config.requestTimeoutMs,
          maxRedirections: 0,
        });

        const contentLengthHeader = response.headers["content-length"];
        const contentLength =
          typeof contentLengthHeader === "string"
            ? Number.parseInt(contentLengthHeader, 10)
            : Array.isArray(contentLengthHeader)
              ? Number.parseInt(contentLengthHeader[0] ?? "", 10)
              : Number.NaN;
        if (Number.isFinite(contentLength) && contentLength > MAX_JSON_RESPONSE_BYTES) {
          await response.body.dump();
          return { ok: false, classification: "permanent", error: "response exceeds size limit" };
        }

        if (response.statusCode === 404) {
          await response.body.dump();
          return { ok: false, classification: "not_found", statusCode: response.statusCode };
        }
        if (response.statusCode === 410) {
          await response.body.dump();
          return { ok: false, classification: "gone", statusCode: response.statusCode };
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          await response.body.dump();
          if (TRANSIENT_HTTP_STATUS_CODES.has(response.statusCode) && attempt + 1 < maxAttempts) {
            await sleep(fullJitterDelayMs(
              this.config.requestRetryBaseDelayMs,
              this.config.requestRetryMaxDelayMs,
              attempt,
            ));
            continue;
          }

          return {
            ok: false,
            classification: TRANSIENT_HTTP_STATUS_CODES.has(response.statusCode) ? "transient" : "permanent",
            statusCode: response.statusCode,
            error: `HTTP ${response.statusCode}`,
          };
        }

        const body = await readJsonBodyWithLimit(response.body, MAX_JSON_RESPONSE_BYTES);
        if (!body) {
          return { ok: false, classification: "permanent", error: "invalid JSON object payload" };
        }

        return { ok: true, body, fingerprint: fingerprintJsonObject(body) };
      } catch (error: any) {
        if (attempt + 1 < maxAttempts) {
          await sleep(fullJitterDelayMs(
            this.config.requestRetryBaseDelayMs,
            this.config.requestRetryMaxDelayMs,
            attempt,
          ));
          continue;
        }

        return { ok: false, classification: "transient", error: error?.message || String(error) };
      }
    }

    return { ok: false, classification: "transient", error: "exhausted retries" };
  }
}

export function createOriginReconciliationWorker(
  queue: RedisStreamsQueue,
  signingClient: SigningClient,
  overrides: Partial<OriginReconciliationWorkerConfig> & { signerActorUri: string },
): OriginReconciliationWorker {
  const config: OriginReconciliationWorkerConfig = {
    concurrency: Number.parseInt(process.env["ORIGIN_RECONCILIATION_CONCURRENCY"] || "4", 10),
    requestTimeoutMs: Number.parseInt(process.env["REQUEST_TIMEOUT_MS"] || "30000", 10),
    requestRetries: Number.parseInt(process.env["ORIGIN_RECONCILIATION_REQUEST_RETRIES"] || "3", 10),
    requestRetryBaseDelayMs: Number.parseInt(process.env["ORIGIN_RECONCILIATION_RETRY_BASE_DELAY_MS"] || "500", 10),
    requestRetryMaxDelayMs: Number.parseInt(process.env["ORIGIN_RECONCILIATION_RETRY_MAX_DELAY_MS"] || "30000", 10),
    userAgent: process.env["USER_AGENT"] || "Fedify-Sidecar/5.0 (ActivityPods)",
    perOriginConcurrency: Number.parseInt(process.env["ORIGIN_RECONCILIATION_PER_ORIGIN_CONCURRENCY"] || "2", 10),
    perOriginBurstLimit: Number.parseInt(process.env["ORIGIN_RECONCILIATION_PER_ORIGIN_BURST_LIMIT"] || "5", 10),
    perOriginBurstWindowSeconds: Number.parseInt(process.env["ORIGIN_RECONCILIATION_PER_ORIGIN_BURST_WINDOW_SECONDS"] || "300", 10),
    maxUnchangedSuccesses: Number.parseInt(process.env["ORIGIN_RECONCILIATION_MAX_UNCHANGED_SUCCESSES"] || "2", 10),
    applyIdempotencyTtlSeconds: Number.parseInt(process.env["ORIGIN_RECONCILIATION_APPLY_TTL_SECONDS"] || "604800", 10),
    ...overrides,
  };

  return new OriginReconciliationWorker(queue, signingClient, config);
}

function nextReconciliationDelayMs(nextAttempt: number): number {
  if (nextAttempt <= 1) return applyJitter(30_000);
  if (nextAttempt === 2) return applyJitter(2 * 60_000);
  if (nextAttempt === 3) return applyJitter(10 * 60_000);
  return applyJitter(30 * 60_000);
}

function nextTransientDelayMs(nextAttempt: number): number {
  return fullJitterDelayMs(30_000, 30 * 60_000, Math.max(0, nextAttempt - 1));
}

function applyJitter(baseMs: number): number {
  return Math.max(1_000, Math.round(baseMs * (0.5 + Math.random() * 0.5)));
}

function fullJitterDelayMs(baseMs: number, maxMs: number, attempt: number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.max(500, Math.round(Math.random() * cap));
}

function fingerprintJsonObject(input: Record<string, unknown>): string {
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

async function readJsonBodyWithLimit(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of body) {
    const next = Buffer.from(chunk);
    totalBytes += next.byteLength;
    if (totalBytes > maxBytes) {
      return null;
    }
    chunks.push(next);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isAllowedRemoteFetchUrl(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
    if (isPrivateIpLiteral(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function isPrivateIpLiteral(hostname: string): boolean {
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }

  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  return false;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
