/**
 * Sidecar Redis Queue
 * 
 * Work queue implementation for the Fedify sidecar runtime.
 * 
 * Handles:
 * - Inbound and outbound delivery job queues (Redis Streams)
 * - Idempotency tracking (Redis Sets)
 * - Domain rate limiting (Redis Sorted Sets)
 * - Domain concurrency slots (Redis Sets)
 * - Dead-letter queue (Redis Streams)
 * - Actor/public-key cache (Redis Hashes)
 * 
 * Key design:
 * - Redis Streams for work queues with consumer groups
 * - XAUTOCLAIM for crash recovery
 * - Redis regular keys for control data (not work queues)
 * - Inbound and outbound streams are separate
 */

import { createClient, RedisClientType } from "redis";
import { logger } from "../utils/logger.js";
import type { PublicSearchConsentSignal } from "../utils/searchConsent.js";

// ============================================================================
// Configuration
// ============================================================================

export interface QueueConfig {
  redisUrl?: string;
  inboundStreamKey?: string;
  outboundStreamKey?: string;
  outboxIntentStreamKey?: string;
  inboundDlqStreamKey?: string;
  outboundDlqStreamKey?: string;
  outboxIntentDlqStreamKey?: string;
  maxDlqLength?: number;
  consumerGroup?: string;
  consumerId?: string;
  blockTimeoutMs?: number;
  claimIdleTimeMs?: number;
  maxStreamLength?: number;
  readBatchCount?: number;
  claimBatchCount?: number;
}

// ============================================================================
// Job Types
// ============================================================================

export interface InboundEnvelope {
  envelopeId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  remoteIp: string;
  receivedAt: number;
  /** Number of forward attempts made so far (0 on first attempt). */
  attempt: number;
  /** Earliest timestamp (ms) at which this envelope should be processed. 0 = immediate. */
  notBeforeMs: number;
  /**
   * Optional verification metadata for envelopes that were already verified
   * by a trusted ingress runtime before being queued.
   */
  verification?: InboundEnvelopeVerification;
}

export interface InboundEnvelopeVerification {
  source: "fedify-v2";
  actorUri: string;
  verifiedAt: number;
}

export interface OutboundJob {
  jobId: string;
  activityId: string;
  actorUri: string;
  activity: string;  // Immutable JSON bytes
  targetInbox: string;
  targetDomain: string;
  attempt: number;
  maxAttempts: number;
  notBeforeMs: number;
  deferCount?: number;
  /** Error message from the last delivery attempt, carried forward for DLQ diagnostics. */
  lastError?: string;
  meta?: {
    isPublicActivity?: boolean;
    isPublicIndexable?: boolean;
    isDeleteOrTombstone?: boolean;
    visibility?: "public" | "unlisted" | "followers" | "direct";
    searchConsent?: PublicSearchConsentSignal;
  };
}

export interface OutboxIntentTarget {
  inboxUrl: string;
  sharedInboxUrl?: string;
  deliveryUrl: string;
  targetDomain: string;
}

export interface OutboxIntent {
  intentId: string;
  activityId: string;
  actorUri: string;
  activity: string;
  targets: OutboxIntentTarget[];
  createdAt: number;
  attempt: number;
  maxAttempts: number;
  notBeforeMs: number;
  lastError?: string;
  meta?: OutboundJob["meta"];
  bridgeHints?: Record<string, unknown>;
}

export interface OutboxIntentState {
  eventLogPublishedAt?: number;
  outboundEnqueuedAt?: number;
  completedAt?: number;
  jobCount?: number;
}

export interface DLQEntry {
  id: string;
  reason: string;
  timestamp: number;
  data: InboundEnvelope | OutboundJob | OutboxIntent;
}

// ============================================================================
// Redis Streams Queue Implementation
// ============================================================================

export class RedisStreamsQueue {
  private redis: RedisClientType;
  private inboundConsumerRedis: RedisClientType;
  private outboundConsumerRedis: RedisClientType;
  private outboxIntentConsumerRedis: RedisClientType;
  private readonly inboundStreamKey: string;
  private readonly outboundStreamKey: string;
  private readonly outboxIntentStreamKey: string;
  private readonly inboundDlqStreamKey: string;
  private readonly outboundDlqStreamKey: string;
  private readonly outboxIntentDlqStreamKey: string;
  private readonly maxDlqLength: number;
  private readonly consumerGroup: string;
  private readonly consumerId: string;
  private readonly blockTimeoutMs: number;
  private readonly claimIdleTimeMs: number;
  private readonly maxStreamLength: number;
  private readonly readBatchCount: number;
  private readonly claimBatchCount: number;

  private isConnected = false;

  constructor(config: QueueConfig = {}) {
    const redisUrl = config.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";

    this.redis = createClient({ url: redisUrl });
    this.inboundConsumerRedis = createClient({ url: redisUrl });
    this.outboundConsumerRedis = createClient({ url: redisUrl });
    this.outboxIntentConsumerRedis = createClient({ url: redisUrl });

    this.inboundStreamKey = config.inboundStreamKey ?? "ap:queue:inbound:v1";
    this.outboundStreamKey = config.outboundStreamKey ?? "ap:queue:outbound:v1";
    this.outboxIntentStreamKey = config.outboxIntentStreamKey ?? "ap:queue:outbox-intent:v1";
    this.inboundDlqStreamKey = config.inboundDlqStreamKey ?? "ap:queue:dlq:inbound:v1";
    this.outboundDlqStreamKey = config.outboundDlqStreamKey ?? "ap:queue:dlq:outbound:v1";
    this.outboxIntentDlqStreamKey = config.outboxIntentDlqStreamKey ?? "ap:queue:dlq:outbox-intent:v1";
    this.maxDlqLength = config.maxDlqLength ?? 10000;
    this.consumerGroup = config.consumerGroup ?? "sidecar-workers";
    this.consumerId = config.consumerId ?? `worker-${process.pid}-${Date.now()}`;
    this.blockTimeoutMs = config.blockTimeoutMs ?? 5000;
    this.claimIdleTimeMs = config.claimIdleTimeMs ?? 60000;
    this.maxStreamLength = config.maxStreamLength ?? 100000;
    this.readBatchCount = normalizeQueueBatchCount(config.readBatchCount, process.env["QUEUE_READ_BATCH_COUNT"], 10);
    this.claimBatchCount = normalizeQueueBatchCount(config.claimBatchCount, process.env["QUEUE_CLAIM_BATCH_COUNT"], 10);

    this.redis.on("error", (err) => {
      logger.error({ error: err.message }, "Redis client error");
    });

    this.inboundConsumerRedis.on("error", (err) => {
      logger.error({ error: err.message }, "Redis inbound consumer error");
    });

    this.outboundConsumerRedis.on("error", (err) => {
      logger.error({ error: err.message }, "Redis outbound consumer error");
    });

    this.outboxIntentConsumerRedis.on("error", (err) => {
      logger.error({ error: err.message }, "Redis outbox-intent consumer error");
    });
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;

    await Promise.all([
      this.redis.connect(),
      this.inboundConsumerRedis.connect(),
      this.outboundConsumerRedis.connect(),
      this.outboxIntentConsumerRedis.connect(),
    ]);

    await this.ensureConsumerGroups();

    this.isConnected = true;
    logger.info("Redis Streams Queue connected", {
      inboundStream: this.inboundStreamKey,
      outboundStream: this.outboundStreamKey,
      outboxIntentStream: this.outboxIntentStreamKey,
      consumerId: this.consumerId,
    });
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    await Promise.all([
      this.redis.quit(),
      this.inboundConsumerRedis.quit(),
      this.outboundConsumerRedis.quit(),
      this.outboxIntentConsumerRedis.quit(),
    ]);
    this.isConnected = false;
    logger.info("Redis Streams Queue disconnected");
  }

  // ==========================================================================
  // Inbound Queue Operations
  // ==========================================================================

  async enqueueInbound(envelope: InboundEnvelope): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const messageId = await this.redis.xAdd(
      this.inboundStreamKey,
      "*",
      {
        envelopeId: envelope.envelopeId,
        method: envelope.method,
        path: envelope.path,
        headers: JSON.stringify(envelope.headers),
        body: envelope.body,
        remoteIp: envelope.remoteIp,
        receivedAt: envelope.receivedAt.toString(),
        attempt: envelope.attempt.toString(),
        notBeforeMs: envelope.notBeforeMs.toString(),
        verification: envelope.verification ? JSON.stringify(envelope.verification) : "",
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } }
    );

    logger.debug("Enqueued inbound envelope", { envelopeId: envelope.envelopeId, messageId });
  }

  async *consumeInbound(): AsyncIterable<{ messageId: string; envelope: InboundEnvelope }> {
    if (!this.isConnected) throw new Error("Queue not connected");

    while (true) {
      try {
        // Read pending messages first (crash recovery)
        const pending = await (this.inboundConsumerRedis as any).xAutoClaim(
          this.inboundStreamKey,
          this.consumerGroup,
          this.consumerId,
          this.claimIdleTimeMs,
          "0-0",
          { COUNT: 10 }
        );

        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {
          const envelope = this.deserializeInboundEnvelope(messageId, fields);
          yield { messageId, envelope };
        }

        // Read new messages
        const messages = await (this.inboundConsumerRedis as any).xReadGroup(
          this.consumerGroup,
          this.consumerId,
          { key: this.inboundStreamKey, id: ">" },
          { COUNT: 10, BLOCK: this.blockTimeoutMs }
        );

        if (!messages || messages.length === 0) {
          continue;
        }

        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {
          for (const [messageId, fields] of streamMessages) {
            const envelope = this.deserializeInboundEnvelope(messageId, fields);
            yield { messageId, envelope };
          }
        }
      } catch (err: any) {
        if (this.isMissingConsumerGroupError(err)) {
          await this.ensureConsumerGroup(this.inboundStreamKey);
        }
        logger.error({ error: err.message }, "Error consuming inbound messages");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private deserializeInboundEnvelope(messageId: string, fields: Record<string, string>): InboundEnvelope {
    return {
      envelopeId: this.requireField(fields, "envelopeId", messageId),
      method: this.requireField(fields, "method", messageId),
      path: this.requireField(fields, "path", messageId),
      headers: JSON.parse(this.requireField(fields, "headers", messageId)),
      body: this.requireField(fields, "body", messageId),
      remoteIp: this.requireField(fields, "remoteIp", messageId),
      receivedAt: parseInt(this.requireField(fields, "receivedAt", messageId), 10),
      attempt: parseInt(fields["attempt"] || "0", 10),
      notBeforeMs: parseInt(fields["notBeforeMs"] || "0", 10),
      verification: this.parseInboundVerification(fields["verification"], messageId),
    };
  }

  private parseInboundVerification(
    raw: string | undefined,
    messageId: string
  ): InboundEnvelopeVerification | undefined {
    if (!raw) return undefined;

    try {
      const parsed = JSON.parse(raw) as Partial<InboundEnvelopeVerification>;
      if (
        parsed.source !== "fedify-v2" ||
        typeof parsed.actorUri !== "string" ||
        typeof parsed.verifiedAt !== "number"
      ) {
        throw new Error("invalid verification metadata");
      }
      return parsed as InboundEnvelopeVerification;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Ignoring malformed inbound verification metadata", {
        messageId,
        error: message,
      });
      return undefined;
    }
  }

  // ==========================================================================
  // Outbound Queue Operations
  // ==========================================================================

  async enqueueOutbound(job: OutboundJob): Promise<void> {
    await this.enqueueOutboundBatch([job]);
  }

  async enqueueOutboundBatch(jobs: OutboundJob[]): Promise<string[]> {
    if (!this.isConnected) throw new Error("Queue not connected");
    if (jobs.length === 0) return [];

    const messageIds: string[] = [];
    const chunkSize = 250;

    for (let index = 0; index < jobs.length; index += chunkSize) {
      const chunk = jobs.slice(index, index + chunkSize);
      const multi = this.redis.multi();

      for (const job of chunk) {
        multi.xAdd(
          this.outboundStreamKey,
          "*",
          this.serializeOutboundJob(job),
          { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } },
        );
      }

      const execResults = await multi.exec();
      if (!Array.isArray(execResults)) {
        throw new Error("Redis multi enqueue returned no results");
      }

      for (const result of execResults) {
        if (typeof result !== "string") {
          throw new Error("Redis multi enqueue returned a non-string message id");
        }
        messageIds.push(result);
      }
    }

    logger.debug("Enqueued outbound jobs", {
      jobCount: jobs.length,
      firstJobId: jobs[0]?.jobId,
      lastJobId: jobs[jobs.length - 1]?.jobId,
    });

    return messageIds;
  }

  async *consumeOutbound(): AsyncIterable<{ messageId: string; job: OutboundJob }> {
    if (!this.isConnected) throw new Error("Queue not connected");

    while (true) {
      try {
        // Read pending messages first (crash recovery)
        const pending = await (this.outboundConsumerRedis as any).xAutoClaim(
          this.outboundStreamKey,
          this.consumerGroup,
          this.consumerId,
          this.claimIdleTimeMs,
          "0-0",
          { COUNT: this.claimBatchCount }
        );

        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {
          const job = this.deserializeOutboundJob(messageId, fields);
          yield { messageId, job };
        }

        // Read new messages
        const messages = await (this.outboundConsumerRedis as any).xReadGroup(
          this.consumerGroup,
          this.consumerId,
          { key: this.outboundStreamKey, id: ">" },
          { COUNT: this.readBatchCount, BLOCK: this.blockTimeoutMs }
        );

        if (!messages || messages.length === 0) {
          continue;
        }

        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {
          for (const [messageId, fields] of streamMessages) {
            const job = this.deserializeOutboundJob(messageId, fields);
            yield { messageId, job };
          }
        }
      } catch (err: any) {
        if (this.isMissingConsumerGroupError(err)) {
          await this.ensureConsumerGroup(this.outboundStreamKey);
        }
        logger.error({ error: err.message }, "Error consuming outbound messages");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // ==========================================================================
  // Outbox Intent Queue Operations
  // ==========================================================================

  async enqueueOutboxIntent(intent: OutboxIntent): Promise<string> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const messageId = await this.redis.xAdd(
      this.outboxIntentStreamKey,
      "*",
      this.serializeOutboxIntent(intent),
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } },
    );

    logger.debug("Enqueued outbox intent", {
      intentId: intent.intentId,
      activityId: intent.activityId,
      messageId,
      targetCount: intent.targets.length,
    });

    return messageId;
  }

  async *consumeOutboxIntents(): AsyncIterable<{ messageId: string; intent: OutboxIntent }> {
    if (!this.isConnected) throw new Error("Queue not connected");

    while (true) {
      try {
        const pending = await (this.outboxIntentConsumerRedis as any).xAutoClaim(
          this.outboxIntentStreamKey,
          this.consumerGroup,
          this.consumerId,
          this.claimIdleTimeMs,
          "0-0",
          { COUNT: this.claimBatchCount },
        );

        for (const [messageId, fields] of this.normalizeClaimedMessages(pending?.messages)) {
          const intent = this.deserializeOutboxIntent(messageId, fields);
          yield { messageId, intent };
        }

        const messages = await (this.outboxIntentConsumerRedis as any).xReadGroup(
          this.consumerGroup,
          this.consumerId,
          { key: this.outboxIntentStreamKey, id: ">" },
          { COUNT: this.readBatchCount, BLOCK: this.blockTimeoutMs },
        );

        if (!messages || messages.length === 0) {
          continue;
        }

        for (const [, streamMessages] of this.normalizeStreamRead(messages)) {
          for (const [messageId, fields] of streamMessages) {
            const intent = this.deserializeOutboxIntent(messageId, fields);
            yield { messageId, intent };
          }
        }
      } catch (err: any) {
        if (this.isMissingConsumerGroupError(err)) {
          await this.ensureConsumerGroup(this.outboxIntentStreamKey);
        }
        logger.error({ error: err.message }, "Error consuming outbox intent messages");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private deserializeOutboxIntent(messageId: string, fields: Record<string, string>): OutboxIntent {
    const rawTargets = this.requireField(fields, "targets", messageId);
    const parsedTargets = JSON.parse(rawTargets) as unknown;
    if (!Array.isArray(parsedTargets)) {
      throw new Error(`Stream message ${messageId} has invalid outbox intent targets`);
    }

    return {
      intentId: this.requireField(fields, "intentId", messageId),
      activityId: this.requireField(fields, "activityId", messageId),
      actorUri: this.requireField(fields, "actorUri", messageId),
      activity: this.requireField(fields, "activity", messageId),
      targets: parsedTargets as OutboxIntentTarget[],
      createdAt: parseInt(this.requireField(fields, "createdAt", messageId), 10),
      attempt: parseInt(this.requireField(fields, "attempt", messageId), 10),
      maxAttempts: parseInt(this.requireField(fields, "maxAttempts", messageId), 10),
      notBeforeMs: parseInt(this.requireField(fields, "notBeforeMs", messageId), 10),
      lastError: fields["lastError"] || undefined,
      meta: fields["meta"] ? JSON.parse(fields["meta"]) : undefined,
      bridgeHints: fields["bridgeHints"] ? JSON.parse(fields["bridgeHints"]) : undefined,
    };
  }

  private deserializeOutboundJob(messageId: string, fields: Record<string, string>): OutboundJob {
    return {
      jobId: this.requireField(fields, "jobId", messageId),
      activityId: this.requireField(fields, "activityId", messageId),
      actorUri: this.requireField(fields, "actorUri", messageId),
      activity: this.requireField(fields, "activity", messageId),
      targetInbox: this.requireField(fields, "targetInbox", messageId),
      targetDomain: this.requireField(fields, "targetDomain", messageId),
      attempt: parseInt(this.requireField(fields, "attempt", messageId), 10),
      maxAttempts: parseInt(this.requireField(fields, "maxAttempts", messageId), 10),
      notBeforeMs: parseInt(this.requireField(fields, "notBeforeMs", messageId), 10),
      deferCount: parseInt(fields["deferCount"] || "0", 10),
      lastError: fields["lastError"] || undefined,
      meta: fields["meta"] ? JSON.parse(fields["meta"]) : undefined,
    };
  }

  private requireField(
    fields: Record<string, string>,
    key: string,
    messageId: string
  ): string {
    const value = fields[key];
    if (value === undefined) {
      throw new Error(`Stream message ${messageId} missing required field ${key}`);
    }
    return value;
  }

  private normalizeClaimedMessages(messages: unknown): Array<[string, Record<string, string>]> {
    if (!Array.isArray(messages)) {
      return [];
    }

    const normalized: Array<[string, Record<string, string>]> = [];
    for (const entry of messages) {
      if (Array.isArray(entry) && entry.length === 2) {
        normalized.push(entry as [string, Record<string, string>]);
        continue;
      }

      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const claimed = entry as { id?: unknown; message?: unknown };
        if (
          typeof claimed.id === "string"
          && claimed.message
          && typeof claimed.message === "object"
          && !Array.isArray(claimed.message)
        ) {
          normalized.push([claimed.id, claimed.message as Record<string, string>]);
        }
      }
    }

    return normalized;
  }

  private normalizeStreamRead(
    streams: unknown
  ): Array<[string, Array<[string, Record<string, string>]>]> {
    if (!Array.isArray(streams)) {
      return [];
    }

    const normalized: Array<[string, Array<[string, Record<string, string>]>]> = [];
    for (const stream of streams) {
      if (Array.isArray(stream) && stream.length === 2) {
        normalized.push(stream as [string, Array<[string, Record<string, string>]>]);
        continue;
      }

      if (stream && typeof stream === "object" && !Array.isArray(stream)) {
        const read = stream as { name?: unknown; messages?: unknown };
        if (typeof read.name === "string") {
          normalized.push([read.name, this.normalizeClaimedMessages(read.messages)]);
        }
      }
    }

    return normalized;
  }

  // ==========================================================================
  // Message Acknowledgment
  // ==========================================================================

  async ack(type: "inbound" | "outbound" | "outbox_intent", messageId: string): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const streamKey =
      type === "inbound"
        ? this.inboundStreamKey
        : type === "outbound"
          ? this.outboundStreamKey
          : this.outboxIntentStreamKey;
    await this.redis.xAck(streamKey, this.consumerGroup, messageId);
    logger.debug("Message acknowledged", { type, messageId });
  }

  // ==========================================================================
  // Idempotency Control
  // ==========================================================================

  async checkIdempotency(job: OutboundJob): Promise<boolean> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:idempotency:outbound:${job.jobId}`;
    const claimed = await this.redis.set(key, "1", {
      EX: 86400,
      NX: true,
    });
    return claimed === "OK";
  }

  async clearIdempotency(job: OutboundJob): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:idempotency:outbound:${job.jobId}`;
    await this.redis.del(key);
  }

  async cacheActorDoc(actorUri: string, document: unknown, ttlSeconds: number = 3600): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    await this.redis.setEx(`ap:actor:${actorUri}`, ttlSeconds, JSON.stringify(document));
  }

  async getCachedActorDoc(actorUri: string): Promise<unknown | null> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const raw = await this.redis.get(`ap:actor:${actorUri}`);
    return raw ? JSON.parse(raw) : null;
  }

  async getPendingCount(type: "inbound" | "outbound" | "outbox_intent"): Promise<number> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const streamKey =
      type === "inbound"
        ? this.inboundStreamKey
        : type === "outbound"
          ? this.outboundStreamKey
          : this.outboxIntentStreamKey;
    let pending: { pending?: number } | null = null;
    try {
      pending = await (this.redis as any).xPending(streamKey, this.consumerGroup);
    } catch (error) {
      if (!this.isMissingConsumerGroupError(error)) {
        throw error;
      }
      await this.ensureConsumerGroup(streamKey);
      pending = await (this.redis as any).xPending(streamKey, this.consumerGroup);
    }
    return typeof pending?.pending === "number" ? pending.pending : 0;
  }

  async getStreamLength(type: "inbound" | "outbound" | "outbox_intent"): Promise<number> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const streamKey =
      type === "inbound"
        ? this.inboundStreamKey
        : type === "outbound"
          ? this.outboundStreamKey
          : this.outboxIntentStreamKey;
    const length = await this.redis.xLen(streamKey);
    return typeof length === "number" ? length : 0;
  }

  // ==========================================================================
  // Domain Control (Blocklist, Rate Limiting, Concurrency)
  // ==========================================================================

  async isDomainBlocked(domain: string): Promise<boolean> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:domain:blocked:${domain}`;
    return (await this.redis.exists(key)) === 1;
  }

  async blockDomain(domain: string, ttlSeconds: number = 3600): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:domain:blocked:${domain}`;
    await this.redis.setEx(key, ttlSeconds, "1");
    logger.info("Domain blocked", { domain, ttlSeconds });
  }

  async unblockDomain(domain: string): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:domain:blocked:${domain}`;
    await this.redis.del(key);
    logger.info("Domain unblocked", { domain });
  }

  async checkDomainRateLimit(domain: string, limit: number = 100, windowSeconds: number = 60): Promise<boolean> {
    if (!this.isConnected) throw new Error("Queue not connected");

    // Atomic: INCR + EXPIRE in a single Lua script to eliminate the TOCTOU
    // race between the INCR and the conditional EXPIRE.
    const script = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const key = `ap:ratelimit:${domain}`;
    const current = await this.redis.eval(script, {
      keys: [key],
      arguments: [windowSeconds.toString()],
    }) as number;

    return current <= limit;
  }

  async acquireDomainSlot(domain: string, maxConcurrent: number = 10): Promise<boolean> {
    if (!this.isConnected) throw new Error("Queue not connected");

    // Atomic: INCR + EXPIRE + conditional DECR in a single Lua script to
    // eliminate the TOCTOU race between the INCR and the conditional EXPIRE,
    // and to keep the counter coherent when the slot is denied.
    const script = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], 3600)
      end
      if current > tonumber(ARGV[1]) then
        redis.call('DECR', KEYS[1])
        return 0
      end
      return 1
    `;
    const key = `ap:domain:slots:${domain}`;
    const result = await this.redis.eval(script, {
      keys: [key],
      arguments: [maxConcurrent.toString()],
    }) as number;

    return result === 1;
  }

  async releaseDomainSlot(domain: string): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:domain:slots:${domain}`;
    await this.redis.decr(key);
  }

  // ==========================================================================
  // Dead Letter Queue
  // ==========================================================================

  async moveToDlq(
    type: "inbound" | "outbound" | "outbox_intent",
    data: InboundEnvelope | OutboundJob | OutboxIntent,
    reason: string,
  ): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const entry: DLQEntry = {
      id:
        type === "inbound"
          ? (data as InboundEnvelope).envelopeId
          : type === "outbound"
            ? (data as OutboundJob).jobId
            : (data as OutboxIntent).intentId,
      reason,
      timestamp: Date.now(),
      data,
    };

    const dlqKey =
      type === "inbound"
        ? this.inboundDlqStreamKey
        : type === "outbound"
          ? this.outboundDlqStreamKey
          : this.outboxIntentDlqStreamKey;

    await this.redis.xAdd(
      dlqKey,
      "*",
      {
        type,
        id: entry.id,
        reason: entry.reason,
        timestamp: entry.timestamp.toString(),
        data: JSON.stringify(entry.data),
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxDlqLength } }
    );

    logger.warn("Message moved to DLQ", { type, id: entry.id, reason });
  }

  // ==========================================================================
  // Configuration Helpers
  // ==========================================================================

  async getMetrics(): Promise<Record<string, number>> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const inboundLen = await this.redis.xLen(this.inboundStreamKey);
    const outboundLen = await this.redis.xLen(this.outboundStreamKey);
    const outboxIntentLen = await this.redis.xLen(this.outboxIntentStreamKey);
    const [dlqInboundLen, dlqOutboundLen, dlqOutboxIntentLen] = await Promise.all([
      this.redis.xLen(this.inboundDlqStreamKey),
      this.redis.xLen(this.outboundDlqStreamKey),
      this.redis.xLen(this.outboxIntentDlqStreamKey),
    ]);

    return {
      inboundQueueLength: inboundLen,
      outboundQueueLength: outboundLen,
      outboxIntentQueueLength: outboxIntentLen,
      dlqInboundLength: dlqInboundLen,
      dlqOutboundLength: dlqOutboundLen,
      dlqOutboxIntentLength: dlqOutboxIntentLen,
    };
  }

  async getDlqLength(type: "inbound" | "outbound" | "outbox_intent"): Promise<number> {
    if (!this.isConnected) throw new Error("Queue not connected");
    const key =
      type === "inbound"
        ? this.inboundDlqStreamKey
        : type === "outbound"
          ? this.outboundDlqStreamKey
          : this.outboxIntentDlqStreamKey;
    return this.redis.xLen(key);
  }

  getClaimIdleTimeMs(): number {
    return this.claimIdleTimeMs;
  }

  private async ensureConsumerGroups(): Promise<void> {
    for (const streamKey of [
      this.inboundStreamKey,
      this.outboundStreamKey,
      this.outboxIntentStreamKey,
    ]) {
      await this.ensureConsumerGroup(streamKey);
    }
  }

  private async ensureConsumerGroup(streamKey: string): Promise<void> {
    try {
      await this.redis.xGroupCreate(streamKey, this.consumerGroup, "0", { MKSTREAM: true });
      logger.info("Created consumer group", { stream: streamKey, group: this.consumerGroup });
    } catch (err: any) {
      if (!err?.message?.includes("BUSYGROUP")) {
        throw err;
      }
    }
  }

  private isMissingConsumerGroupError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("NOGROUP");
  }

  private serializeOutboundJob(job: OutboundJob): Record<string, string> {
    return {
      jobId: job.jobId,
      activityId: job.activityId,
      actorUri: job.actorUri,
      activity: job.activity,
      targetInbox: job.targetInbox,
      targetDomain: job.targetDomain,
      attempt: job.attempt.toString(),
      maxAttempts: job.maxAttempts.toString(),
      notBeforeMs: job.notBeforeMs.toString(),
      deferCount: (job.deferCount ?? 0).toString(),
      lastError: job.lastError ?? "",
      meta: job.meta ? JSON.stringify(job.meta) : "",
    };
  }

  private serializeOutboxIntent(intent: OutboxIntent): Record<string, string> {
    return {
      intentId: intent.intentId,
      activityId: intent.activityId,
      actorUri: intent.actorUri,
      activity: intent.activity,
      targets: JSON.stringify(intent.targets),
      createdAt: intent.createdAt.toString(),
      attempt: intent.attempt.toString(),
      maxAttempts: intent.maxAttempts.toString(),
      notBeforeMs: intent.notBeforeMs.toString(),
      lastError: intent.lastError ?? "",
      meta: intent.meta ? JSON.stringify(intent.meta) : "",
      bridgeHints: intent.bridgeHints ? JSON.stringify(intent.bridgeHints) : "",
    };
  }

  async getOutboxIntentState(intentId: string): Promise<OutboxIntentState> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const raw = await this.redis.hGetAll(this.outboxIntentStateKey(intentId));
    return {
      eventLogPublishedAt: raw["eventLogPublishedAt"] ? Number.parseInt(raw["eventLogPublishedAt"], 10) : undefined,
      outboundEnqueuedAt: raw["outboundEnqueuedAt"] ? Number.parseInt(raw["outboundEnqueuedAt"], 10) : undefined,
      completedAt: raw["completedAt"] ? Number.parseInt(raw["completedAt"], 10) : undefined,
      jobCount: raw["jobCount"] ? Number.parseInt(raw["jobCount"], 10) : undefined,
    };
  }

  async markOutboxIntentEventLogPublished(intentId: string, publishedAt: number = Date.now()): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const stateKey = this.outboxIntentStateKey(intentId);
    await this.redis.hSet(stateKey, "eventLogPublishedAt", publishedAt.toString());
    await this.redis.expire(stateKey, 60 * 60 * 24 * 7);
  }

  async enqueueOutboundBatchForIntent(
    intentId: string,
    jobs: OutboundJob[],
  ): Promise<{ enqueued: boolean; jobCount: number }> {
    if (!this.isConnected) throw new Error("Queue not connected");
    if (jobs.length === 0) {
      const stateKey = this.outboxIntentStateKey(intentId);
      await this.redis.hSet(stateKey, {
        outboundEnqueuedAt: Date.now().toString(),
        jobCount: "0",
      });
      await this.redis.expire(stateKey, 60 * 60 * 24 * 7);
      return { enqueued: true, jobCount: 0 };
    }

    const script = `
      local stateKey = KEYS[1]
      local outboundStreamKey = KEYS[2]
      local maxLen = ARGV[1]
      local outboundEnqueuedAt = ARGV[2]
      local jobCount = tonumber(ARGV[3])
      if redis.call('HGET', stateKey, 'outboundEnqueuedAt') then
        local existingCount = redis.call('HGET', stateKey, 'jobCount')
        return { '0', existingCount or tostring(jobCount) }
      end
      local index = 4
      for i = 1, jobCount do
        redis.call(
          'XADD',
          outboundStreamKey,
          'MAXLEN', '~', maxLen,
          '*',
          'jobId', ARGV[index],
          'activityId', ARGV[index + 1],
          'actorUri', ARGV[index + 2],
          'activity', ARGV[index + 3],
          'targetInbox', ARGV[index + 4],
          'targetDomain', ARGV[index + 5],
          'attempt', ARGV[index + 6],
          'maxAttempts', ARGV[index + 7],
          'notBeforeMs', ARGV[index + 8],
          'deferCount', ARGV[index + 9],
          'lastError', ARGV[index + 10],
          'meta', ARGV[index + 11]
        )
        index = index + 12
      end
      redis.call('HSET', stateKey, 'outboundEnqueuedAt', outboundEnqueuedAt, 'jobCount', tostring(jobCount))
      redis.call('EXPIRE', stateKey, 604800)
      return { '1', tostring(jobCount) }
    `;

    const args = [
      this.maxStreamLength.toString(),
      Date.now().toString(),
      jobs.length.toString(),
      ...jobs.flatMap((job) => {
        const serialized = this.serializeOutboundJob(job);
        return [
          serialized["jobId"] ?? "",
          serialized["activityId"] ?? "",
          serialized["actorUri"] ?? "",
          serialized["activity"] ?? "",
          serialized["targetInbox"] ?? "",
          serialized["targetDomain"] ?? "",
          serialized["attempt"] ?? "0",
          serialized["maxAttempts"] ?? "0",
          serialized["notBeforeMs"] ?? "0",
          serialized["deferCount"] ?? "0",
          serialized["lastError"] ?? "",
          serialized["meta"] ?? "",
        ];
      }),
    ];

    const result = await this.redis.eval(script, {
      keys: [this.outboxIntentStateKey(intentId), this.outboundStreamKey],
      arguments: args,
    }) as [string, string] | null;

    if (!Array.isArray(result) || result.length < 2) {
      throw new Error("Redis outbox intent fanout script returned an invalid result");
    }

    return {
      enqueued: result[0] === "1",
      jobCount: Number.parseInt(result[1] ?? `${jobs.length}`, 10),
    };
  }

  async markOutboxIntentCompleted(intentId: string, completedAt: number = Date.now()): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const stateKey = this.outboxIntentStateKey(intentId);
    await this.redis.hSet(stateKey, "completedAt", completedAt.toString());
    await this.redis.expire(stateKey, 60 * 60 * 24 * 7);
  }

  private outboxIntentStateKey(intentId: string): string {
    return `ap:outbox-intent:state:${intentId}`;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createDefaultConfig(): QueueConfig {
  return {
    redisUrl: process.env["REDIS_URL"],
    inboundStreamKey: process.env["INBOUND_STREAM_KEY"] || "ap:queue:inbound:v1",
    outboundStreamKey: process.env["OUTBOUND_STREAM_KEY"] || "ap:queue:outbound:v1",
    outboxIntentStreamKey:
      process.env["OUTBOX_INTENT_STREAM_KEY"] || "ap:queue:outbox-intent:v1",
    inboundDlqStreamKey: process.env["DLQ_INBOUND_STREAM_KEY"] || "ap:queue:dlq:inbound:v1",
    outboundDlqStreamKey: process.env["DLQ_OUTBOUND_STREAM_KEY"] || "ap:queue:dlq:outbound:v1",
    outboxIntentDlqStreamKey: process.env["DLQ_OUTBOX_INTENT_STREAM_KEY"] || "ap:queue:dlq:outbox-intent:v1",
    maxDlqLength: parseInt(process.env["MAX_DLQ_LENGTH"] || "10000", 10),
    consumerGroup: process.env["CONSUMER_GROUP"] || "sidecar-workers",
    blockTimeoutMs: parseInt(process.env["BLOCK_TIMEOUT_MS"] || "5000", 10),
    claimIdleTimeMs: parseInt(process.env["CLAIM_IDLE_TIME_MS"] || "60000", 10),
    maxStreamLength: parseInt(process.env["MAX_STREAM_LENGTH"] || "500000", 10),
    readBatchCount: parseInt(process.env["QUEUE_READ_BATCH_COUNT"] || "10", 10),
    claimBatchCount: parseInt(process.env["QUEUE_CLAIM_BATCH_COUNT"] || "10", 10),
  };
}

function normalizeQueueBatchCount(
  configured: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(1, Math.min(250, Math.floor(configured)));
  }

  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1, Math.min(250, parsed));
    }
  }

  return fallback;
}

export function createInboundEnvelope(params: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  remoteIp: string;
  verification?: InboundEnvelopeVerification;
}): InboundEnvelope {
  return {
    envelopeId: crypto.randomUUID(),
    method: params.method,
    path: params.path,
    headers: params.headers,
    body: params.body,
    remoteIp: params.remoteIp,
    receivedAt: Date.now(),
    attempt: 0,
    notBeforeMs: 0,
    ...(params.verification ? { verification: params.verification } : {}),
  };
}

export function createVerifiedInboundEnvelope(params: {
  path: string;
  body: string;
  remoteIp: string;
  verifiedActorUri: string;
  verifiedAt?: number;
  headers?: Record<string, string>;
}): InboundEnvelope {
  return createInboundEnvelope({
    method: "POST",
    path: params.path,
    headers: params.headers ?? {},
    body: params.body,
    remoteIp: params.remoteIp,
    verification: {
      source: "fedify-v2",
      actorUri: params.verifiedActorUri,
      verifiedAt: params.verifiedAt ?? Date.now(),
    },
  });
}

export function createOutboxIntent(params: {
  activityId: string;
  actorUri: string;
  activity: string;
  targets: OutboxIntentTarget[];
  meta?: OutboundJob["meta"];
  bridgeHints?: Record<string, unknown>;
}): OutboxIntent {
  return {
    intentId: crypto.randomUUID(),
    activityId: params.activityId,
    actorUri: params.actorUri,
    activity: params.activity,
    targets: params.targets,
    createdAt: Date.now(),
    attempt: 0,
    maxAttempts: parseInt(process.env["OUTBOX_INTENT_MAX_ATTEMPTS"] || "8", 10),
    notBeforeMs: 0,
    ...(params.meta ? { meta: params.meta } : {}),
    ...(params.bridgeHints ? { bridgeHints: params.bridgeHints } : {}),
  };
}

/**
 * Calculate exponential backoff with Mastodon-compatible tiers
 * 
 * Tier 1: 1 min (attempt 1-2)
 * Tier 2: 5 min (attempt 3-4)
 * Tier 3: 30 min (attempt 5-6)
 * Tier 4: 2 hours (attempt 7+)
 */
export function backoffMs(attempt: number): number {
  if (attempt <= 2) return 60 * 1000; // 1 min
  if (attempt <= 4) return 5 * 60 * 1000; // 5 min
  if (attempt <= 6) return 30 * 60 * 1000; // 30 min
  return 2 * 60 * 60 * 1000; // 2 hours
}
