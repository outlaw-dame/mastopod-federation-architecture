import { createClient } from "redis";
import { logger } from "../utils/logger.js";
import { migrateLegacyCompletedDeliveryMarkers } from "../delivery/outbound-delivery-claims.js";
import {
  APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS,
  outboxIntentAgeMs,
  redisStreamMessageTimestampMs,
} from "../delivery/apdm-replay-horizon.js";
import {
  RedisStreamsQueue as CoreRedisStreamsQueue,
  type QueueConfig,
  type OutboundJob,
} from "./sidecar-redis-queue-core.js";

export * from "./sidecar-redis-queue-core.js";

export const DELAYED_OUTBOUND_PROMOTION_INTERVAL_MS = 250;
export const DELAYED_OUTBOUND_MIN_DELAY_MS = 2_000;
export const DELAYED_OUTBOUND_PROMOTION_BATCH_SIZE = 100;
export const DELAYED_OUTBOUND_PARK_RETRY_MS = 1_000;
export const DELAYED_OUTBOUND_PARK_MAX_RETRY_MS = 30_000;

type DelayedRedisClient = ReturnType<typeof createClient>;

/**
 * Durability wrapper around the core Redis Streams queue.
 *
 * The ready outbound Stream is intentionally MAXLEN-trimmed. Future-dated
 * retries therefore bypass that Stream and are written directly to a durable
 * ZSET + payload hash. Legacy/fresh ready entries that are discovered with a
 * long not-before are atomically moved to the same delayed store and ACKed.
 * Due promotion recreates ready work, while the original first-enqueue time is
 * carried in job metadata so delayed residence can never reset the APDM clock.
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

    // Existing core queue tests mock only the five core clients. Focused
    // delayed-queue tests run with NODE_ENV=production and own the sixth mock.
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

  override async enqueueOutbound(job: OutboundJob): Promise<void> {
    await this.enqueueOutboundBatch([job]);
  }

  override async enqueueOutboundBatch(jobs: OutboundJob[]): Promise<string[]> {
    if (jobs.length === 0) return [];

    const nowMs = Date.now();
    const immediate: OutboundJob[] = [];
    const delayed: OutboundJob[] = [];

    for (const job of jobs) {
      const stamped = this.ensureFirstQueuedAt(job, nowMs);
      if (
        this.delayedRedis
        && stamped.notBeforeMs > 0
        && stamped.notBeforeMs - nowMs > DELAYED_OUTBOUND_MIN_DELAY_MS
      ) {
        delayed.push(stamped);
      } else {
        immediate.push(stamped);
      }
    }

    const messageIds = immediate.length > 0
      ? await super.enqueueOutboundBatch(immediate)
      : [];

    for (const job of delayed) {
      await this.storeDelayedOutbound(job);
      // No ready-Stream ID exists yet. The token is diagnostic-only; current
      // callers do not use enqueueOutboundBatch IDs as an ACK handle.
      messageIds.push(`delayed:${job.jobId}`);
    }

    return messageIds;
  }

  override async *consumeOutbound(): AsyncIterable<{ messageId: string; job: OutboundJob }> {
    for await (const entry of super.consumeOutbound()) {
      const streamTimestamp = redisStreamMessageTimestampMs(entry.messageId);
      if (streamTimestamp === null) {
        // Preserve the worker's existing fail-closed Stream-ID validation.
        yield entry;
        continue;
      }

      const job = this.ensureFirstQueuedAt(entry.job, streamTimestamp);
      const firstQueuedAtMs = job.meta?.apdmFirstQueuedAtMs;
      const residenceMs = typeof firstQueuedAtMs === "number"
        ? outboxIntentAgeMs(firstQueuedAtMs)
        : null;

      if (
        residenceMs === null
        || residenceMs > APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS
      ) {
        const reason = `Outbound message exceeded the ${APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS} ms APDM queue residence limit`;
        try {
          await this.moveToDlq("outbound", { ...job, lastError: reason }, reason);
          await this.ack("outbound", entry.messageId);
        } catch (error) {
          logger.error(
            {
              jobId: job.jobId,
              messageId: entry.messageId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to persist expired outbound job; source remains pending",
          );
        }
        continue;
      }

      let remainingDelayMs = job.notBeforeMs - Date.now();
      if (
        this.delayedRedis
        && job.notBeforeMs > 0
        && remainingDelayMs > DELAYED_OUTBOUND_MIN_DELAY_MS
      ) {
        let retryDelayMs = DELAYED_OUTBOUND_PARK_RETRY_MS;
        let parked = false;

        while (remainingDelayMs > DELAYED_OUTBOUND_MIN_DELAY_MS) {
          try {
            await this.parkDelayedOutbound(entry.messageId, job);
            parked = true;
            break;
          } catch (error) {
            logger.error(
              {
                jobId: job.jobId,
                messageId: entry.messageId,
                retryDelayMs,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to park future outbound job; retrying same pending source",
            );
            await this.sleep(retryDelayMs);
            retryDelayMs = Math.min(retryDelayMs * 2, DELAYED_OUTBOUND_PARK_MAX_RETRY_MS);

            const retryResidenceMs = typeof firstQueuedAtMs === "number"
              ? outboxIntentAgeMs(firstQueuedAtMs)
              : null;
            if (
              retryResidenceMs === null
              || retryResidenceMs > APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS
            ) {
              const reason = `Outbound message exceeded the ${APDM_OUTBOUND_MESSAGE_MAX_RESIDENCE_MS} ms APDM queue residence limit while retrying delayed parking`;
              let dlqRetryDelayMs = DELAYED_OUTBOUND_PARK_RETRY_MS;
              let dlqPersisted = false;

              while (!dlqPersisted) {
                try {
                  await this.moveToDlq("outbound", { ...job, lastError: reason }, reason);
                  dlqPersisted = true;
                } catch (dlqError) {
                  logger.error(
                    {
                      jobId: job.jobId,
                      messageId: entry.messageId,
                      retryDelayMs: dlqRetryDelayMs,
                      error: dlqError instanceof Error ? dlqError.message : String(dlqError),
                    },
                    "Failed to persist expired outbound job during delayed-park retry; retaining in-memory source and retrying DLQ",
                  );
                  await this.sleep(dlqRetryDelayMs);
                  dlqRetryDelayMs = Math.min(
                    dlqRetryDelayMs * 2,
                    DELAYED_OUTBOUND_PARK_MAX_RETRY_MS,
                  );
                }
              }

              try {
                await this.ack("outbound", entry.messageId);
              } catch (ackError) {
                logger.error(
                  {
                    jobId: job.jobId,
                    messageId: entry.messageId,
                    error: ackError instanceof Error ? ackError.message : String(ackError),
                  },
                  "Expired outbound job is durable in DLQ but source ACK failed",
                );
              }
              parked = true;
              break;
            }

            remainingDelayMs = job.notBeforeMs - Date.now();
          }
        }

        if (parked) continue;
      }

      yield { messageId: entry.messageId, job };
    }
  }

  private ensureFirstQueuedAt(job: OutboundJob, fallbackMs: number): OutboundJob {
    const existing = job.meta?.apdmFirstQueuedAtMs;
    if (typeof existing === "number" && Number.isFinite(existing) && existing > 0) {
      return job;
    }
    return {
      ...job,
      meta: {
        ...(job.meta ?? {}),
        apdmFirstQueuedAtMs: fallbackMs,
      },
    };
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

  private async storeDelayedOutbound(job: OutboundJob): Promise<void> {
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
      return replace and 1 or 0
    `;

    await this.delayedRedis.eval(script, {
      keys: [this.delayedScheduleKey, this.delayedPayloadKey],
      arguments: [
        job.jobId,
        String(job.notBeforeMs),
        JSON.stringify(job),
        String(job.attempt),
      ],
    });
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
      {
        jobId: job.jobId,
        messageId,
        notBeforeMs: job.notBeforeMs,
        firstQueuedAtMs: job.meta?.apdmFirstQueuedAtMs,
      },
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
