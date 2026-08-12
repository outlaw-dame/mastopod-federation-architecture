import { createClient, type RedisClientType } from "redis";
import {
  APDM_AUTOMATIC_PRODUCER_REPLAY_MAX_MS,
  APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS,
  APDM_MAX_CLOCK_SKEW_MS,
} from "./apdm-replay-horizon.js";

export type DeliveryClaimResult = "claimed" | "completed" | "in_flight";

export const MIN_COMPLETED_DELIVERY_TTL_MS = APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS;
export const LEGACY_COMPLETED_KEY_PREFIX = "ap:delivery:completed:";
export const COMPLETED_KEY_PREFIX = "ap:delivery:completed:v2:";
export const COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY = "ap:delivery:completed:v2:migration-complete";
export const COMPLETED_DELIVERY_CUTOVER_MODE = "maintenance";
export const COMPLETED_DELIVERY_FRESH_INSTALL_MODE = "fresh";
export const COMPLETED_DELIVERY_BLACKOUT_STARTED_AT_ENV = "APDM_COMPLETION_MARKER_V2_BLACKOUT_STARTED_AT_MS";
export const LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS =
  APDM_AUTOMATIC_PRODUCER_REPLAY_MAX_MS + APDM_MAX_CLOCK_SKEW_MS;

export function normalizeCompletedDeliveryTtlMs(ttlMs: number): number {
  const normalized = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : 0;
  return Math.max(MIN_COMPLETED_DELIVERY_TTL_MS, normalized);
}

export interface CompletedDeliveryCutoverRequest {
  mode: typeof COMPLETED_DELIVERY_CUTOVER_MODE | typeof COMPLETED_DELIVERY_FRESH_INSTALL_MODE;
  blackoutStartedAtMs?: number;
}

/**
 * Validate the first-v2-start operator declaration.
 *
 * We deliberately do not infer a fresh installation from an empty legacy
 * namespace: an upgrade may also have no live v1 markers because the previous
 * 24-hour TTL already expired them. Upgrade mode therefore requires a replay
 * blackout long enough for both the producer's 48-hour lookback and the
 * sidecar's pre-cutover queued work to age outside the new fail-closed horizon.
 */
export function validateCompletedDeliveryCutoverRequest(
  modeRaw: string | undefined,
  blackoutStartedAtRaw: string | undefined,
  nowMs: number = Date.now(),
): CompletedDeliveryCutoverRequest {
  if (modeRaw === COMPLETED_DELIVERY_FRESH_INSTALL_MODE) {
    return { mode: COMPLETED_DELIVERY_FRESH_INSTALL_MODE };
  }

  if (modeRaw !== COMPLETED_DELIVERY_CUTOVER_MODE) {
    throw new Error(
      `First v2 startup requires APDM_COMPLETION_MARKER_V2_CUTOVER=${COMPLETED_DELIVERY_FRESH_INSTALL_MODE} for a proven fresh Redis deployment or APDM_COMPLETION_MARKER_V2_CUTOVER=${COMPLETED_DELIVERY_CUTOVER_MODE} for an upgrade`,
    );
  }

  const blackoutStartedAtMs = Number(blackoutStartedAtRaw);
  if (!Number.isSafeInteger(blackoutStartedAtMs) || blackoutStartedAtMs <= 0) {
    throw new Error(
      `${COMPLETED_DELIVERY_BLACKOUT_STARTED_AT_ENV} must be the epoch-millisecond time when automatic ActivityPods reconciliation and all legacy sidecar workers were stopped`,
    );
  }

  const elapsedMs = nowMs - blackoutStartedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS) {
    throw new Error(
      `Legacy APDM cutover blackout must remain in force for at least ${LEGACY_COMPLETED_DELIVERY_BLACKOUT_MS} ms before v2 queue consumption`,
    );
  }

  return { mode: COMPLETED_DELIVERY_CUTOVER_MODE, blackoutStartedAtMs };
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
 * The legacy key format has no version/index metadata, and already-expired v1
 * markers cannot be reconstructed from Redis. Correct migration therefore
 * requires an explicit first-start declaration. A proven fresh deployment may
 * use `fresh` only when the legacy namespace is empty. An upgrade must disable
 * automatic reconciliation, stop every legacy sidecar worker, hold that
 * blackout for 48h + accepted clock skew, and then use `maintenance`.
 *
 * Waiting the full producer lookback also means any pre-cutover outbox/outbound
 * work is older than the upgraded sidecar's 48-hour residence limits, so it is
 * rejected before a duplicate claim or external POST. The permanent sentinel
 * makes this disruptive fence strictly one-time; later starts need no flag.
 */
export async function migrateLegacyCompletedDeliveryMarkers(
  redisUrl: string = process.env["REDIS_URL"] ?? "redis://localhost:6379",
): Promise<number> {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();
  try {
    if (await redis.exists(COMPLETED_DELIVERY_CUTOVER_SENTINEL_KEY)) {
      return 0;
    }

    const request = validateCompletedDeliveryCutoverRequest(
      process.env["APDM_COMPLETION_MARKER_V2_CUTOVER"],
      process.env[COMPLETED_DELIVERY_BLACKOUT_STARTED_AT_ENV],
    );

    const result = await redis.eval(
      `
        local legacyPrefix = ARGV[1]
        local v2Prefix = ARGV[2]
        local ttlMs = ARGV[3]
        local requestedMode = ARGV[4]
        local maintenanceMode = ARGV[5]
        local freshMode = ARGV[6]

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

        if requestedMode == freshMode and #legacyKeys > 0 then
          return redis.error_reply(
            'fresh APDM v2 cutover refused because legacy completed-delivery markers exist'
          )
        end
        if requestedMode ~= freshMode and requestedMode ~= maintenanceMode then
          return redis.error_reply('invalid APDM completed-delivery cutover mode')
        end

        local migrated = 0
        if requestedMode == maintenanceMode then
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
          request.mode,
          COMPLETED_DELIVERY_CUTOVER_MODE,
          COMPLETED_DELIVERY_FRESH_INSTALL_MODE,
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
