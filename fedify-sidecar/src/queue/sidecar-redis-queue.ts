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

// ============================================================================
// Configuration
// ============================================================================

export interface QueueConfig {
  redisUrl?: string;
  inboundStreamKey?: string;
  outboundStreamKey?: string;
  dlqStreamKey?: string;
  consumerGroup?: string;
  consumerId?: string;
  blockTimeoutMs?: number;
  claimIdleTimeMs?: number;
  maxStreamLength?: number;
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
  lastError?: string;
  meta?: {
    isPublicIndexable?: boolean;
    isDeleteOrTombstone?: boolean;
    visibility?: "public" | "unlisted" | "followers" | "direct";
    searchConsent?: {
      raw?: string[];
      isPublic?: boolean;
      explicitlySet?: boolean;
    };
  };
}

export interface DLQEntry {
  id: string;
  reason: string;
  timestamp: number;
  data: InboundEnvelope | OutboundJob;
}

// ============================================================================
// Redis Streams Queue Implementation
// ============================================================================

export class RedisStreamsQueue {
  private redis: RedisClientType;
  private subRedis: RedisClientType;
  private readonly inboundStreamKey: string;
  private readonly outboundStreamKey: string;
  private readonly dlqStreamKey: string;
  private readonly consumerGroup: string;
  private readonly consumerId: string;
  private readonly blockTimeoutMs: number;
  private readonly claimIdleTimeMs: number;
  private readonly maxStreamLength: number;

  private isConnected = false;
  private inboundListener: AsyncIterable<{ messageId: string; envelope: InboundEnvelope }> | null = null;
  private outboundListener: AsyncIterable<{ messageId: string; job: OutboundJob }> | null = null;

  constructor(config: QueueConfig = {}) {
    const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";

    this.redis = createClient({ url: redisUrl });
    this.subRedis = createClient({ url: redisUrl });

    this.inboundStreamKey = config.inboundStreamKey ?? "ap:queue:inbound:v1";
    this.outboundStreamKey = config.outboundStreamKey ?? "ap:queue:outbound:v1";
    this.dlqStreamKey = config.dlqStreamKey ?? "ap:queue:dlq:v1";
    this.consumerGroup = config.consumerGroup ?? "sidecar-workers";
    this.consumerId = config.consumerId ?? `worker-${process.pid}-${Date.now()}`;
    this.blockTimeoutMs = config.blockTimeoutMs ?? 5000;
    this.claimIdleTimeMs = config.claimIdleTimeMs ?? 60000;
    this.maxStreamLength = config.maxStreamLength ?? 100000;

    this.redis.on("error", (err) => {
      logger.error("Redis client error", { error: err.message });
    });

    this.subRedis.on("error", (err) => {
      logger.error("Redis sub client error", { error: err.message });
    });
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.isConnected) return;

    await Promise.all([this.redis.connect(), this.subRedis.connect()]);

    // Create consumer groups for both streams
    for (const streamKey of [this.inboundStreamKey, this.outboundStreamKey]) {
      try {
        await this.redis.xGroupCreate(streamKey, this.consumerGroup, "0", { MKSTREAM: true });
        logger.info("Created consumer group", { stream: streamKey, group: this.consumerGroup });
      } catch (err: any) {
        if (!err.message?.includes("BUSYGROUP")) {
          throw err;
        }
      }
    }

    this.isConnected = true;
    logger.info("Redis Streams Queue connected", {
      inboundStream: this.inboundStreamKey,
      outboundStream: this.outboundStreamKey,
      consumerId: this.consumerId,
    });
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    await Promise.all([this.redis.quit(), this.subRedis.quit()]);
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
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } }
    );

    logger.debug("Enqueued inbound envelope", { envelopeId: envelope.envelopeId, messageId });
  }

  async *consumeInbound(): AsyncIterable<{ messageId: string; envelope: InboundEnvelope }> {
    if (!this.isConnected) throw new Error("Queue not connected");

    let lastId = ">";

    while (true) {
      try {
        // Read pending messages first (crash recovery)
        const pending = await this.redis.xAutoClaim(
          this.inboundStreamKey,
          this.consumerGroup,
          this.consumerId,
          this.claimIdleTimeMs,
          "0-0",
          { COUNT: 10 }
        );

        for (const msg of pending.messages) {
          if (!msg) continue;
          const id = String(msg.id);
          const envelope = this.deserializeInboundEnvelope(id, msg.message as Record<string, string>);
          yield { messageId: id, envelope };
        }

        // Read new messages
        const messages = await this.redis.xReadGroup(
          this.consumerGroup,
          this.consumerId,
          { key: this.inboundStreamKey, id: lastId },
          { COUNT: 10, BLOCK: this.blockTimeoutMs }
        );

        if (!messages || messages.length === 0) {
          continue;
        }

        for (const stream of messages) {
          for (const msg of stream.messages) {
            lastId = String(msg.id);
            const envelope = this.deserializeInboundEnvelope(lastId, msg.message as Record<string, string>);
            yield { messageId: lastId, envelope };
          }
        }
      } catch (err: any) {
        logger.error("Error consuming inbound messages", { error: err.message });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private deserializeInboundEnvelope(messageId: string, fields: Record<string, string>): InboundEnvelope {
    return {
      envelopeId: fields['envelopeId']!,
      method: fields['method']!,
      path: fields['path']!,
      headers: JSON.parse(fields['headers']!),
      body: fields['body']!,
      remoteIp: fields['remoteIp']!,
      receivedAt: parseInt(fields['receivedAt']!, 10),
    };
  }

  // ==========================================================================
  // Outbound Queue Operations
  // ==========================================================================

  async enqueueOutbound(job: OutboundJob): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const messageId = await this.redis.xAdd(
      this.outboundStreamKey,
      "*",
      {
        jobId: job.jobId,
        activityId: job.activityId,
        actorUri: job.actorUri,
        activity: job.activity,
        targetInbox: job.targetInbox,
        targetDomain: job.targetDomain,
        attempt: job.attempt.toString(),
        maxAttempts: job.maxAttempts.toString(),
        notBeforeMs: job.notBeforeMs.toString(),
        meta: job.meta ? JSON.stringify(job.meta) : "",
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxStreamLength } }
    );

    logger.debug("Enqueued outbound job", { jobId: job.jobId, messageId });
  }

  async *consumeOutbound(): AsyncIterable<{ messageId: string; job: OutboundJob }> {
    if (!this.isConnected) throw new Error("Queue not connected");

    let lastId = ">";

    while (true) {
      try {
        // Read pending messages first (crash recovery)
        const pending = await this.redis.xAutoClaim(
          this.outboundStreamKey,
          this.consumerGroup,
          this.consumerId,
          this.claimIdleTimeMs,
          "0-0",
          { COUNT: 10 }
        );

        for (const msg of pending.messages) {
          if (!msg) continue;
          const id = String(msg.id);
          const job = this.deserializeOutboundJob(id, msg.message as Record<string, string>);
          yield { messageId: id, job };
        }

        // Read new messages
        const messages = await this.redis.xReadGroup(
          this.consumerGroup,
          this.consumerId,
          { key: this.outboundStreamKey, id: lastId },
          { COUNT: 10, BLOCK: this.blockTimeoutMs }
        );

        if (!messages || messages.length === 0) {
          continue;
        }

        for (const stream of messages) {
          for (const msg of stream.messages) {
            lastId = String(msg.id);
            const job = this.deserializeOutboundJob(lastId, msg.message as Record<string, string>);
            yield { messageId: lastId, job };
          }
        }
      } catch (err: any) {
        logger.error("Error consuming outbound messages", { error: err.message });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private deserializeOutboundJob(messageId: string, fields: Record<string, string>): OutboundJob {
    return {
      jobId: fields['jobId']!,
      activityId: fields['activityId']!,
      actorUri: fields['actorUri']!,
      activity: fields['activity']!,
      targetInbox: fields['targetInbox']!,
      targetDomain: fields['targetDomain']!,
      attempt: parseInt(fields['attempt']!, 10),
      maxAttempts: parseInt(fields['maxAttempts']!, 10),
      notBeforeMs: parseInt(fields['notBeforeMs']!, 10),
      meta: fields['meta'] ? JSON.parse(fields['meta']) : undefined,
    };
  }

  // ==========================================================================
  // Message Acknowledgment
  // ==========================================================================

  async ack(type: "inbound" | "outbound", messageId: string): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const streamKey = type === "inbound" ? this.inboundStreamKey : this.outboundStreamKey;
    await this.redis.xAck(streamKey, this.consumerGroup, messageId);
    logger.debug("Message acknowledged", { type, messageId });
  }

  // ==========================================================================
  // Idempotency Control
  // ==========================================================================

  async checkIdempotency(job: OutboundJob): Promise<boolean> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:idempotency:outbound:${job.jobId}`;
    const exists = await this.redis.exists(key);

    if (exists === 0) {
      // Mark as processed
      await this.redis.setEx(key, 86400, "1"); // 24 hour TTL
      return true;
    }

    return false;
  }

  async clearIdempotency(job: OutboundJob): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:idempotency:outbound:${job.jobId}`;
    await this.redis.del(key);
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

    const key = `ap:ratelimit:${domain}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    return current <= limit;
  }

  async acquireDomainSlot(domain: string, maxConcurrent: number = 10): Promise<boolean> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:domain:slots:${domain}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      // Set a 1-hour TTL to prevent stale slots
      await this.redis.expire(key, 3600);
    }

    if (current > maxConcurrent) {
      await this.redis.decr(key);
      return false;
    }

    return true;
  }

  async releaseDomainSlot(domain: string): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const key = `ap:domain:slots:${domain}`;
    await this.redis.decr(key);
  }

  // ==========================================================================
  // Dead Letter Queue
  // ==========================================================================

  async moveToDlq(type: "inbound" | "outbound", data: InboundEnvelope | OutboundJob, reason: string): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");

    const entry: DLQEntry = {
      id: type === "inbound" ? (data as InboundEnvelope).envelopeId : (data as OutboundJob).jobId,
      reason,
      timestamp: Date.now(),
      data,
    };

    await this.redis.xAdd(
      this.dlqStreamKey,
      "*",
      {
        type,
        id: entry.id,
        reason: entry.reason,
        timestamp: entry.timestamp.toString(),
        data: JSON.stringify(entry.data),
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10000 } }
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
    const dlqLen = await this.redis.xLen(this.dlqStreamKey);

    return {
      inboundQueueLength: inboundLen,
      outboundQueueLength: outboundLen,
      dlqLength: dlqLen,
    };
  }

  // ==========================================================================
  // Stream Metrics
  // ==========================================================================

  async getStreamLength(type: "inbound" | "outbound"): Promise<number> {
    if (!this.isConnected) throw new Error("Queue not connected");
    const key = type === "inbound" ? this.inboundStreamKey : this.outboundStreamKey;
    return this.redis.xLen(key);
  }

  async getPendingCount(type: "inbound" | "outbound"): Promise<number> {
    if (!this.isConnected) throw new Error("Queue not connected");
    const key = type === "inbound" ? this.inboundStreamKey : this.outboundStreamKey;
    const info = await this.redis.xPending(key, this.consumerGroup);
    return info.pending;
  }

  // ==========================================================================
  // Actor Document Cache
  // ==========================================================================

  async getCachedActorDoc(actorUri: string): Promise<Record<string, unknown> | null> {
    if (!this.isConnected) throw new Error("Queue not connected");
    const cacheKey = `ap:actor-cache:${actorUri}`;
    const raw = await this.redis.get(cacheKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async cacheActorDoc(actorUri: string, doc: Record<string, unknown>, ttlSeconds = 300): Promise<void> {
    if (!this.isConnected) throw new Error("Queue not connected");
    const cacheKey = `ap:actor-cache:${actorUri}`;
    await this.redis.setEx(cacheKey, ttlSeconds, JSON.stringify(doc));
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createDefaultConfig(): QueueConfig {
  return {
    redisUrl: process.env.REDIS_URL,
    inboundStreamKey: process.env.INBOUND_STREAM_KEY || "ap:queue:inbound:v1",
    outboundStreamKey: process.env.OUTBOUND_STREAM_KEY || "ap:queue:outbound:v1",
    dlqStreamKey: process.env.DLQ_STREAM_KEY || "ap:queue:dlq:v1",
    consumerGroup: process.env.CONSUMER_GROUP || "sidecar-workers",
    blockTimeoutMs: parseInt(process.env.BLOCK_TIMEOUT_MS || "5000", 10),
    claimIdleTimeMs: parseInt(process.env.CLAIM_IDLE_TIME_MS || "60000", 10),
    maxStreamLength: parseInt(process.env.MAX_STREAM_LENGTH || "100000", 10),
  };
}

export function createInboundEnvelope(params: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  remoteIp: string;
}): InboundEnvelope {
  return {
    envelopeId: crypto.randomUUID(),
    method: params.method,
    path: params.path,
    headers: params.headers,
    body: params.body,
    remoteIp: params.remoteIp,
    receivedAt: Date.now(),
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
