import { createClient, type RedisClientType } from "redis";

export type DeliveryClaimResult = "claimed" | "completed" | "in_flight";

export interface OutboundDeliveryClaimStore {
  claim(jobId: string, claimToken: string, ttlMs: number): Promise<DeliveryClaimResult>;
  complete(jobId: string, claimToken: string, ttlMs: number): Promise<void>;
  release(jobId: string, claimToken: string): Promise<void>;
  close(): Promise<void>;
}

export class RedisOutboundDeliveryClaimStore implements OutboundDeliveryClaimStore {
  private readonly redis: RedisClientType;
  private connectPromise: Promise<void> | null = null;

  constructor(redisUrl: string = process.env["REDIS_URL"] ?? "redis://localhost:6379") {
    this.redis = createClient({ url: redisUrl });
    this.redis.on("error", () => {
      // Runtime logging remains owned by the worker; Redis commands reject and
      // are handled by the existing worker error/DLQ path.
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
    return `ap:delivery:completed:${jobId}`;
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
        arguments: [claimToken, String(Math.max(1000, Math.floor(ttlMs)))],
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
    if (!this.redis.isOpen) return;
    await this.redis.quit();
  }
}
