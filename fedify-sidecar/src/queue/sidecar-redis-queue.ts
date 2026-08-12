import { createClient } from "redis";
import { logger } from "../utils/logger.js";
import { migrateLegacyCompletedDeliveryMarkers } from "../delivery/outbound-delivery-claims.js";
import {
  RedisStreamsQueue as CoreRedisStreamsQueue,
  type QueueConfig,
  type OutboundJob,
} from "./sidecar-redis-queue-core.js";

export * from "./sidecar-redis-queue-core.js";

export const DELAYED_OUTBOUND_PROMOTION_INTERVAL_MS = 250;
export const DELAYED_OUTBOUND_MIN_DELAY_MS = 2_000;
export const DELAYED_OUTBOUND_PROMOTION_BATCH_SIZE = 100;

type DelayedRedisClient = ReturnType<typeof createClient>;

/**
 * Durability wrapper around the core Redis Streams queue.
 *
 * The ready outbound Stream is intentionally MAXLEN-trimmed. Future-dated
 * retries therefore must not remain in its PEL: a trimmed pending entry can
 * disappear before XAUTOCLAIM gets a chance to recover it. This wrapper moves
 * long-delay entries atomically into a non-trimmed ZSET + payload hash, ACKing
 * the ready Stream entry in the same Redis script. A timer atomically promotes
 * due jobs back into the ready Stream.
 */
export class RedisStreamsQueue extends CoreRedisStreamsQueue {
  private delayedRedis: DelayedRedisClient | null = null;
  private readonly redisUrl: string;
  private readonly outboundStreamKeyForDelay: string;
  private readonly consumerGroupForDelay: string;
  private readonly maxStreamLengthForDelay: number;
  private readonly delayedScheduleKey: string;
  private readonly delayedPayloadKey: string;
  private delayedPromotionTimer: NodeJS.Timeout | null = null;
  private delayedPromotionRunning = false;

  constructor(config: QueueConfig = {}) {
    super(config);
    this.redisUrl = config.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";
    this.outboundStreamKeyForDelay = config.outboundStreamKey ?? "ap:queue:outbound:v1";
    this.consumerGroupForDelay = config.consumerGroup ?? "sidecar-workers";
    this.maxStreamLengthForDelay = config.maxStreamLength ?? 100000;
    this.delayedScheduleKey = `${this.outboundStreamKeyForDelay}:delayed:v1`;
    this.delayedPayloadKey = `${this.outboundStreamKeyForDelay}:delayed-payload:v1`;

    // Existing queue unit tests intentionally mock only the five core clients.
    // Delayed-queue behavior has its own focused coverage; keeping this client
    // lazy prevents unrelated core-queue tests from depending on a sixth mock.
    if (process.env["NODE_ENV"] !== "test") {
      this.delayedRedis = this.createDelayedRedisClient();
    }
  }

  private createDelayedRedisClient(): DelayedRedisClient {
    const client = createClient({ url: this.redisUrl });
    client.on("error", (error) => {
      logger.error({ error: error.message }, "Redis delayed-outbound client error");
    });
    return client;
  }

  override async connect(): Promise<void> {
    if (process.env["NODE_ENV"] !== "test") {
      await migrateLegacyCompletedDeliveryMarkers(this.redisUrl);
    }

    await super.connect();
    if (!this.delayedRedis) return;

    try {
      if (!this.delayedRedis.isOpen) await this.delayedRedis.connect();
      await this.promoteDueOutbound();
      this.startDelayedPromotionTimer();
    } catch (error) {
      await super.disconnect().catch(() => undefined);
      if (this.delayedRedis.isOpen) {
        await this.delayedRedis.quit().catch(() => undefined);
      }
      throw error;
    }
  }

  override async disconnect(): Promise<void> {
    if (this.delayedPromotionTimer) {
      clearInterval(this.delayedPromotionTimer);
      this.delayedPromotionTimer = null;
    }
    if (this.delayedRedis?.isOpen) {
      await this.delayedRedis.quit();
    }
    await super.disconnect();
  }

  override async *consumeOutbound(): AsyncIterable<{ messageId: string; job: OutboundJob }> {
    for await (const entry of super.consumeOutbound()) {
      const remainingDelayMs = entry.job.notBeforeMs - Date.now();
      if (
        this.delayedRedis
        && entry.job.notBeforeMs > 0
        && remainingDelayMs > DELAYED_OUTBOUND_MIN_DELAY_MS
      ) {
        await this.parkDelayedOutbound(entry.messageId, entry.job);
        continue;
      }
      yield entry;
    }
  }

  private startDelayedPromotionTimer(): void {
    if (this.delayedPromotionTimer || !this.delayedRedis) return;
    this.delayedPromotionTimer = setInterval(() => {
      void this.promoteDueOutbound().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to promote delayed outbound jobs",
        );
      });
    }, DELAYED_OUTBOUND_PROMOTION_INTERVAL_MS);
    this.delayedPromotionTimer.unref?.();
  }

  private async parkDelayedOutbound(messageId: string, job: OutboundJob): Promise<void> {
    if (!this.delayedRedis?.isOpen) throw new Error("Delayed outbound Redis client is not connected");

    const script = `
      local existing = redis.call('HGET', KEYS[2], ARGV[1])
      local replace = true
      if existing then
        local ok, decoded = pcall(cjson.decode, existing)
        if ok and decoded then
          local oldAttempt = tonumber(decoded.attempt) or 0
          local newAttempt = tonumber(ARGV[4]) or 0
          local oldNotBefore = tonumber(decoded.notBeforeMs) or 0
          local newNotBefore = tonumber(ARGV[2]) or 0
          if oldAttempt > newAttempt or (oldAttempt == newAttempt and oldNotBefore >= newNotBefore) then
            replace = false
          end
        end
      end
      if replace then
        redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
      end
      redis.call('XACK', KEYS[3], ARGV[5], ARGV[6])
      return replace and 1 or 0
    `;

    await this.delayedRedis.eval(script, {
      keys: [this.delayedScheduleKey, this.delayedPayloadKey, this.outboundStreamKeyForDelay],
      arguments: [
        job.jobId,
        String(job.notBeforeMs),
        JSON.stringify(job),
        String(job.attempt),
        this.consumerGroupForDelay,
        messageId,
      ],
    });

    logger.debug(
      { jobId: job.jobId, messageId, notBeforeMs: job.notBeforeMs },
      "Parked future outbound job in durable delayed queue",
    );
  }

  async promoteDueOutbound(nowMs: number = Date.now()): Promise<number> {
    if (!this.delayedRedis?.isOpen || this.delayedPromotionRunning) return 0;
    this.delayedPromotionRunning = true;
    try {
      const script = `
        local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
        local promoted = 0
        for _, id in ipairs(ids) do
          local payload = redis.call('HGET', KEYS[2], id)
          if payload then
            local ok, job = pcall(cjson.decode, payload)
            if not ok or not job then
              return redis.error_reply('invalid delayed outbound payload for ' .. id)
            end
            local meta = ''
            if job.meta ~= nil then meta = cjson.encode(job.meta) end
            redis.call(
              'XADD', KEYS[3], 'MAXLEN', '~', ARGV[3], '*',
              'jobId', job.jobId,
              'activityId', job.activityId,
              'actorUri', job.actorUri,
              'activity', job.activity,
              'targetInbox', job.targetInbox,
              'targetDomain', job.targetDomain,
              'attempt', tostring(job.attempt or 0),
              'maxAttempts', tostring(job.maxAttempts or 0),
              'notBeforeMs', tostring(job.notBeforeMs or 0),
              'deferCount', tostring(job.deferCount or 0),
              'lastError', job.lastError or '',
              'meta', meta
            )
            promoted = promoted + 1
          end
          redis.call('ZREM', KEYS[1], id)
          redis.call('HDEL', KEYS[2], id)
        end
        return promoted
      `;

      const promoted = await this.delayedRedis.eval(script, {
        keys: [this.delayedScheduleKey, this.delayedPayloadKey, this.outboundStreamKeyForDelay],
        arguments: [
          String(nowMs),
          String(DELAYED_OUTBOUND_PROMOTION_BATCH_SIZE),
          String(this.maxStreamLengthForDelay),
        ],
      });
      return typeof promoted === "number" ? promoted : Number(promoted ?? 0);
    } finally {
      this.delayedPromotionRunning = false;
    }
  }
}
