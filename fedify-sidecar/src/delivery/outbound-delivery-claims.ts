import { createClient, type RedisClientType } from "redis";
import { APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS } from "./apdm-replay-horizon.js";

export type DeliveryClaimResult = "claimed" | "completed" | "in_flight";

export const MIN_COMPLETED_DELIVERY_TTL_MS = APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS;
export const LEGACY_COMPLETED_KEY_PREFIX = "ap:delivery:completed:";
export const COMPLETED_KEY_PREFIX = "ap:delivery:completed:v2:";
export const COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY = "ap:delivery:completed:v2:migration-complete";
export const COMPLETED_DELIVERY_CUTOVER_MODE = "maintenance";

export function normalizeCompletedDeliveryTtlMs(ttlMs: number): number {
  const normalized = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : 0;
  return Math.max(MIN_COMPLETED_DELIVERY_TTL_MS, normalized);
}

export interface OutboundDeliveryClaimStore {
  claim(jobId: string, claimToken: string, ttlMs: number): Promise<DeliveryClaimResult>;
  complete(jobId: string, claimToken: string, ttlMs: number): Promise<void>;
  release(jobId: string, claimToken: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * One-time v1 -> v2 completed-marker cutover.
 *
 * The legacy key format has no version/index metadata, so an incremental SCAN
 * cannot prove it observed a marker before that marker expires. Correct
 * migration therefore uses one atomic namespace conversion during an explicit
 * maintenance boundary with legacy outbound workers stopped. A permanent
 * sentinel makes the blocking conversion strictly one-time: fresh installs set
 * the sentinel without requiring a maintenance flag, while installations that
 * actually contain legacy markers fail closed until the operator acknowledges
 * the cutover mode.
 */
export async function migrateLegacyCompletedDeliveryMarkers(
  redisUrl: string = process.env["REDIS_URL"] ?? "redis://localhost:6379",
): Promise<number> {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();
  try {
    const result = await redis.eval(
      `
        local legacyPrefix = ARGV[1]
        local v2Prefix = ARGV[2]
        local ttlMs = ARGV[3]
        local requestedMode = ARGV[4]
        local requiredMode = ARGV[5]

        if redis.call('EXISTS', KEYS[1]) == 1 then
          return 0
        end

        local keys = redis.call('KEYS', legacyPrefix .. '*')
        local legacyKeys = {}
        for _, key in ipairs(keys) do
          if string.sub(key, 1, string.len(v2Prefix)) ~= v2Prefix then
            table.insert(legacyKeys, key)
          end
        end

        if #legacyKeys > 0 and requestedMode ~= requiredMode then
          return redis.error_reply(
            'legacy APDM completed markers exist; stop all legacy outbound workers and set APDM_COMPLETION_MARKER_V2_CUTOVER=' .. requiredMode
          )
        end

        local migrated = 0
        for _, legacyKey in ipairs(legacyKeys) do
          local suffix = string.sub(legacyKey, string.len(legacyPrefix) + 1)
          local v2Key = v2Prefix .. suffix
          if redis.call('EXISTS', legacyKey) == 1 then
            if redis.call('EXISTS', v2Key) == 0 then
              redis.call('SET', v2Key, 'v2', 'PX', ttlMs)
            end
            redis.call('DEL', legacyKey)
            migrated = migrated + 1
          end
        end

        redis.call('SET', KEYS[1], '1')
        return migrated
      `,
      {
        keys: [COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY],
        arguments: [
          LEGACY_COMPLETED_KEY_PREFIX,
          COMPLETED_KEY_PREFIX,
          String(MIN_COMPLETED_DELIVERY_TTL_MS),
          process.env["APDM_COMPLETION_MARKER_V2_CUTOVER"] ?? "",
          COMPLETED_DELIVERY_CUTOVER_MODE,
        ],
      },
    );
    return typeof result === "number" ? result : Number(result ?? 0);
  } finally {
    await redis.quit();
  }
}

export class RedisOutboundDeliveryClaimStore implements OutboundDeliveryClaimStore {
  private readonly redis: RedisClientType;
  private connectPromise: Promise<void> | null = null;

  constructor(redisUrl: string = process.env["REDIS_URL"] ?? "redis://localhost:6379") {
    this.redis = createClient({ url: redisUrl });
    this.redis.on("error", () => {
      // Runtime logging remains owned by the worker; Redis commands reject and
      // are handled by the worker's durable recovery path.
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = this.redis.connect().then(() => undefined).finally(() => {
        this.connectPromise = null;
      });
    }
    await this.connectPromise;
  }

  private completedKey(jobId: string): string {
    return `${COMPLETED_KEY_PREFIX}${jobId}`;
  }

  private legacyCompletedKey(jobId: string): string {
    return `${LEGACY_COMPLETED_KEY_PREFIX}${jobId}`;
  }

  private claimKey(jobId: string): string {
    return `ap:delivery:claim:${jobId}`;
  }

  async claim(jobId: string, claimToken: string, ttlMs: number): Promise<DeliveryClaimResult> {
    await this.ensureConnected();
    const result = await this.redis.eval(
      `
        if redis.call('EXISTS', KEYS[1]) == 1 then
          return 'completed'
        end
        if redis.call('EXISTS', KEYS[2]) == 1 then
          if redis.call('EXISTS', KEYS[1]) == 0 then
            redis.call('SET', KEYS[1], 'v2', 'PX', ARGV[2])
          end
          redis.call('DEL', KEYS[2])
          return 'completed'
        end
        local claimed = redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[3], 'NX')
        if claimed then
          return 'claimed'
        end
        if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
          return 'completed'
        end
        return 'in_flight'
      `,
      {
        keys: [this.completedKey(jobId), this.legacyCompletedKey(jobId), this.claimKey(jobId)],
        arguments: [
          claimToken,
          String(MIN_COMPLETED_DELIVERY_TTL_MS),
          String(Math.max(1000, Math.floor(ttlMs))),
        ],
      },
    );
    if (result === "completed" || result === "claimed" || result === "in_flight") return result;
    throw new Error(`Unexpected outbound delivery claim result: ${String(result)}`);
  }

  async complete(jobId: string, claimToken: string, ttlMs: number): Promise<void> {
    await this.ensureConnected();
    const completedTtlMs = normalizeCompletedDeliveryTtlMs(ttlMs);
    await this.redis.eval(
      `
        redis.call('SET', KEYS[1], 'v2', 'PX', ARGV[2])
        redis.call('DEL', KEYS[2])
        if redis.call('GET', KEYS[3]) == ARGV[1] then
          redis.call('DEL', KEYS[3])
        end
        return 1
      `,
      {
        keys: [this.completedKey(jobId), this.legacyCompletedKey(jobId), this.claimKey(jobId)],
        arguments: [claimToken, String(completedTtlMs)],
      },
    );
  }

  async release(jobId: string, claimToken: string): Promise<void> {
    await this.ensureConnected();
    await this.redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      {
        keys: [this.claimKey(jobId)],
        arguments: [claimToken],
      },
    );
  }

  async close(): Promise<void> {
    if (!this.redis.isOpen) return;
    await this.redis.quit();
  }
}
