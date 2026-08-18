import { createClient } from "redis";
import type { OutboxIntent } from "../queue/sidecar-redis-queue.js";
import { logger } from "../utils/logger.js";

export const OUTBOX_INTENT_DELAY_PROMOTION_INTERVAL_MS = 250;
export const OUTBOX_INTENT_DELAY_PROMOTION_BATCH_SIZE = 100;

export interface OutboxIntentDelayScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  persistReplacementAndAck(messageId: string, intent: OutboxIntent): Promise<void>;
  promoteDue(nowMs?: number): Promise<number>;
}

export interface RedisOutboxIntentDelaySchedulerConfig {
  redisUrl: string;
  readyStreamKey: string;
  dlqStreamKey: string;
  consumerGroup: string;
  maxStreamLength: number;
  maxDlqLength: number;
  promotionIntervalMs?: number;
  promotionBatchSize?: number;
}

type RedisClient = ReturnType<typeof createClient>;

/**
 * Durable delayed-work store for APDM outbox intents.
 *
 * Redis Streams are the ready queue and are intentionally MAXLEN-trimmed, so a
 * future-dated retry cannot safely live there: a hot consumer would repeatedly
 * re-read a replacement, while a pending entry can be trimmed underneath the
 * PEL. Delayed intents therefore live in a non-trimmed ZSET + payload hash and
 * are promoted to the ready Stream only when due.
 *
 * The source transition is atomic: delayed payload/schedule are persisted
 * before XACK in the same Lua script. Promotion is likewise atomic: XADD the
 * ready entry, then remove the delayed record. A crash cannot create an
 * ACK-without-replacement gap. Malformed/orphaned delayed records are moved to
 * the existing outbox-intent DLQ in the same promotion script so one corrupt
 * record cannot permanently head-of-line block all healthy delayed work.
 */
export class RedisOutboxIntentDelayScheduler implements OutboxIntentDelayScheduler {
  private readonly redis: RedisClient;
  private readonly readyStreamKey: string;
  private readonly dlqStreamKey: string;
  private readonly consumerGroup: string;
  private readonly maxStreamLength: number;
  private readonly maxDlqLength: number;
  private readonly scheduleKey: string;
  private readonly payloadKey: string;
  private readonly promotionIntervalMs: number;
  private readonly promotionBatchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private promotionRunning = false;

  constructor(config: RedisOutboxIntentDelaySchedulerConfig) {
    this.redis = createClient({ url: config.redisUrl });
    this.readyStreamKey = config.readyStreamKey;
    this.dlqStreamKey = config.dlqStreamKey;
    this.consumerGroup = config.consumerGroup;
    this.maxStreamLength = config.maxStreamLength;
    this.maxDlqLength = config.maxDlqLength;
    this.scheduleKey = `${config.readyStreamKey}:delayed:v1`;
    this.payloadKey = `${config.readyStreamKey}:delayed-payload:v1`;
    this.promotionIntervalMs = config.promotionIntervalMs ?? OUTBOX_INTENT_DELAY_PROMOTION_INTERVAL_MS;
    this.promotionBatchSize = config.promotionBatchSize ?? OUTBOX_INTENT_DELAY_PROMOTION_BATCH_SIZE;

    this.redis.on("error", error => {
      logger.error({ error: error.message }, "Redis delayed outbox-intent client error");
    });
  }

  async start(): Promise<void> {
    if (!this.redis.isOpen) await this.redis.connect();
    await this.promoteDue();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.promoteDue().catch(error => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to promote delayed outbox intents",
        );
      });
    }, this.promotionIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.redis.isOpen) await this.redis.quit();
  }

  async persistReplacementAndAck(messageId: string, intent: OutboxIntent): Promise<void> {
    if (!this.redis.isOpen) throw new Error("Delayed outbox-intent Redis client is not connected");
    if (!Number.isFinite(intent.notBeforeMs) || intent.notBeforeMs <= Date.now()) {
      throw new Error("Delayed outbox intent must have a future notBeforeMs");
    }

    // A later attempt wins. For the same attempt, preserve the later deadline;
    // this makes duplicate crash recovery monotonic rather than moving work
    // backwards in time.
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

    await this.redis.eval(script, {
      keys: [this.scheduleKey, this.payloadKey, this.readyStreamKey],
      arguments: [
        intent.intentId,
        String(intent.notBeforeMs),
        JSON.stringify(intent),
        String(intent.attempt),
        this.consumerGroup,
        messageId,
      ],
    });
  }

  async promoteDue(nowMs: number = Date.now()): Promise<number> {
    if (!this.redis.isOpen || this.promotionRunning) return 0;
    this.promotionRunning = true;
    try {
      const script = `
        local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
        local promoted = 0
        for _, id in ipairs(ids) do
          local payload = redis.call('HGET', KEYS[2], id)
          local valid = false
          local intent = nil
          if payload then
            local ok, decoded = pcall(cjson.decode, payload)
            if ok and decoded and decoded.intentId == id and type(decoded.activityId) == 'string' and
              type(decoded.actorUri) == 'string' and type(decoded.activity) == 'string' and
              type(decoded.targets) == 'table' and tonumber(decoded.createdAt) and
              tonumber(decoded.attempt) and tonumber(decoded.maxAttempts) and tonumber(decoded.notBeforeMs) then
              valid = true
              intent = decoded
            end
          end

          if valid then
            local meta = ''
            if intent.meta ~= nil then meta = cjson.encode(intent.meta) end
            local bridgeHints = ''
            if intent.bridgeHints ~= nil then bridgeHints = cjson.encode(intent.bridgeHints) end
            redis.call(
              'XADD', KEYS[3], 'MAXLEN', '~', ARGV[3], '*',
              'intentId', intent.intentId,
              'activityId', intent.activityId,
              'actorUri', intent.actorUri,
              'activity', intent.activity,
              'targets', cjson.encode(intent.targets),
              'createdAt', tostring(intent.createdAt),
              'attempt', tostring(intent.attempt),
              'maxAttempts', tostring(intent.maxAttempts),
              'notBeforeMs', tostring(intent.notBeforeMs),
              'lastError', intent.lastError or '',
              'meta', meta,
              'bridgeHints', bridgeHints
            )
            promoted = promoted + 1
          else
            local reason = payload and 'Corrupt delayed outbox-intent payload' or 'Orphaned delayed outbox-intent schedule entry'
            local diagnostic = cjson.encode({
              intentId = id,
              delayedPayload = payload or cjson.null,
              scheduler = 'outbox-intent-delayed-v1'
            })
            redis.call(
              'XADD', KEYS[4], 'MAXLEN', '~', ARGV[4], '*',
              'type', 'outbox_intent',
              'id', id,
              'reason', reason,
              'timestamp', ARGV[1],
              'data', diagnostic
            )
          end
          redis.call('ZREM', KEYS[1], id)
          redis.call('HDEL', KEYS[2], id)
        end
        return promoted
      `;

      const result = await this.redis.eval(script, {
        keys: [this.scheduleKey, this.payloadKey, this.readyStreamKey, this.dlqStreamKey],
        arguments: [
          String(nowMs),
          String(this.promotionBatchSize),
          String(this.maxStreamLength),
          String(this.maxDlqLength),
        ],
      });
      return typeof result === "number" ? result : Number(result ?? 0);
    } finally {
      this.promotionRunning = false;
    }
  }
}

export function createRedisOutboxIntentDelaySchedulerFromEnv(): RedisOutboxIntentDelayScheduler {
  return new RedisOutboxIntentDelayScheduler({
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    readyStreamKey: process.env["OUTBOX_INTENT_STREAM_KEY"] ?? "ap:queue:outbox-intent:v1",
    dlqStreamKey: process.env["DLQ_OUTBOX_INTENT_STREAM_KEY"] ?? "ap:queue:dlq:outbox-intent:v1",
    consumerGroup: process.env["CONSUMER_GROUP"] ?? "sidecar-workers",
    maxStreamLength: parsePositiveInt(process.env["MAX_STREAM_LENGTH"], 500_000),
    maxDlqLength: parsePositiveInt(process.env["MAX_DLQ_LENGTH"], 10_000),
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
