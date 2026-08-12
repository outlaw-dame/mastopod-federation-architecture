import { createClient, type RedisClientType } from "redis";
import { APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS } from "./apdm-replay-horizon.js";

export type DeliveryClaimResult = "claimed" | "completed" | "in_flight";

export const MIN_COMPLETED_DELIVERY_TTL_MS = APDM_COMPLETED_DELIVERY_MIN_RETENTION_MS;
export const COMPLETED_DELIVERY_RETENTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const COMPLETED_KEY_PREFIX = "ap:delivery:completed:";
const RETENTION_SWEEP_SCAN_COUNT = 250;

export function normalizeCompletedDeliveryTtlMs(ttlMs: number): number {
  const normalized = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : 0;
  return Math.max(MIN_COMPLETED_DELIVERY_TTL_MS, normalized);
}

export function shouldExtendCompletedDeliveryTtl(ttlMs: number): boolean {
  // Redis PTTL: -1 means the key has no expiry, -2 means it no longer exists.
  // Neither case should be converted into a new finite lifetime.
  return Number.isFinite(ttlMs) && ttlMs >= 0 && ttlMs < MIN_COMPLETED_DELIVERY_TTL_MS;
}

export interface OutboundDeliveryClaimStore {
  claim(jobId: string, claimToken: string, ttlMs: number): Promise<DeliveryClaimResult>;
  complete(jobId: string, claimToken: string, ttlMs: number): Promise<void>;
  release(jobId: string, claimToken: string): Promise<void>;
  close(): Promise<void>;
}

export class RedisOutboundDeliveryClaimStore implements OutboundDeliveryClaimStore {
  private readonly redis: RedisClientType;
  private connectPromise: Promise<void> | null = null;
  private initialRetentionSweepPromise: Promise<void> | null = null;
  private retentionSweepTimer: NodeJS.Timeout | null = null;
  private retentionSweepRunning = false;

  constructor(redisUrl: string = process.env["REDIS_URL"] ?? "redis://localhost:6379") {
    this.redis = createClient({ url: redisUrl });
    this.redis.on("error", () => {
      // Runtime logging remains owned by the worker; Redis commands reject and
      // are handled by the existing worker error/DLQ path.
    });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.redis.isOpen) {
      if (!this.connectPromise) {
        this.connectPromise = this.redis.connect().then(() => undefined).finally(() => {
          this.connectPromise = null;
        });
      }
      await this.connectPromise;
    }

    // Before this upgraded store is allowed to claim any delivery, migrate
    // legacy 24-hour completed markers to the new retention floor. A periodic
    // sweep then covers short-lived markers written by old workers during a
    // rolling deployment until those workers have drained.
    if (!this.initialRetentionSweepPromise) {
      this.initialRetentionSweepPromise = this.sweepCompletedMarkerRetention();
    }
    await this.initialRetentionSweepPromise;
    this.startRetentionSweepTimer();
  }

  private startRetentionSweepTimer(): void {
    if (this.retentionSweepTimer) return;
    this.retentionSweepTimer = setInterval(() => {
      void this.sweepCompletedMarkerRetention().catch(() => {
        // A failed background sweep does not mutate markers. The next interval
        // retries; command errors from foreground claim/complete remain visible
        // to the worker. The interval is far shorter than the legacy 24h TTL.
      });
    }, COMPLETED_DELIVERY_RETENTION_SWEEP_INTERVAL_MS);
    this.retentionSweepTimer.unref?.();
  }

  private async sweepCompletedMarkerRetention(): Promise<void> {
    if (this.retentionSweepRunning || !this.redis.isOpen) return;
    this.retentionSweepRunning = true;

    try {
      // SCAN is incremental/nonblocking. node-redis v5's iterator yields small
      // batches, so migration does not issue a production-wide KEYS operation.
      for await (const keys of this.redis.scanIterator({
        MATCH: `${COMPLETED_KEY_PREFIX}*`,
        COUNT: RETENTION_SWEEP_SCAN_COUNT,
      })) {
        for (const key of keys) {
          const ttlMs = await this.redis.pTTL(key);
          if (shouldExtendCompletedDeliveryTtl(ttlMs)) {
            await this.redis.pExpire(key, MIN_COMPLETED_DELIVERY_TTL_MS);
          }
        }
      }
    } finally {
      this.retentionSweepRunning = false;
    }
  }

  private completedKey(jobId: string): string {
    return `${COMPLETED_KEY_PREFIX}${jobId}`;
  }

  private claimKey(jobId: string): string {
    return `ap:delivery:claim:${jobId}`;
  }

  async claim(jobId: string, claimToken: string, ttlMs: number): Promise<DeliveryClaimResult> {
    await this.ensureConnected();
    const completedKey = this.completedKey(jobId);
    const claimKey = this.claimKey(jobId);

    if (await this.redis.exists(completedKey)) return "completed";

    const claimed = await this.redis.set(claimKey, claimToken, {
      PX: Math.max(1000, Math.floor(ttlMs)),
      NX: true,
    });
    if (claimed === "OK") return "claimed";

    // Close the race where another worker completed between the first completed
    // check and our failed NX claim.
    if (await this.redis.exists(completedKey)) return "completed";
    return "in_flight";
  }

  async complete(jobId: string, claimToken: string, ttlMs: number): Promise<void> {
    await this.ensureConnected();
    const completedTtlMs = normalizeCompletedDeliveryTtlMs(ttlMs);
    await this.redis.eval(
      `
        redis.call('set', KEYS[1], '1', 'PX', ARGV[2])
        if redis.call('get', KEYS[2]) == ARGV[1] then
          redis.call('del', KEYS[2])
        end
        return 1
      `,
      {
        keys: [this.completedKey(jobId), this.claimKey(jobId)],
        arguments: [claimToken, String(completedTtlMs)],
      },
    );
  }

  async release(jobId: string, claimToken: string): Promise<void> {
    await this.ensureConnected();
    await this.redis.eval(
      `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
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
    if (this.retentionSweepTimer) {
      clearInterval(this.retentionSweepTimer);
      this.retentionSweepTimer = null;
    }
    if (!this.redis.isOpen) return;
    await this.redis.quit();
  }
}
