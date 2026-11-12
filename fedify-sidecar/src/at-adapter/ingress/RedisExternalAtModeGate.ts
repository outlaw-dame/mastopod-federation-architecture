/**
 * Shared Redis admission policy for external ATProto ingestion.
 *
 * Verified Sync and unverified Jetstream must never coexist in one fleet
 * using the same Redis authority. Each active process renews the SAME mode.
 * Redis failover and divergent Redis deployments remain rollout gates.
 */
import type { ExternalAtIngestionSource } from "./AtExternalIngestionPolicy.js";
import { withRedisFenceDeadline } from "./RedisFenceDeadline.js";

export interface ExternalModeRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const MATCH_MODE = [
  "local existing = redis.call('GET', KEYS[1])",
  "if existing and existing ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])",
  "return 1",
].join("\n");

export class RedisExternalAtModeGate {
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private active = false;
  private onLost: (() => void) | null = null;
  private mode: ExternalAtIngestionSource = "disabled";

  constructor(
    private readonly redis: ExternalModeRedis,
    private readonly key = "at:external-ingestion:mode:v1",
    private readonly ttlMs = 15000,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 500 || ttlMs > 120000) {
      throw new Error("External ingress mode TTL out of range");
    }
    if (!/^at:[a-z0-9:._-]{3,120}$/.test(key)) {
      throw new Error("Invalid external ingestion mode key");
    }
  }

  async start(mode: ExternalAtIngestionSource, onLost: () => void): Promise<void> {
    if (mode === "disabled") return;
    if (this.active || this.timer) throw new Error("Mode gate already active");
    const acquired = await this.checkMode(mode);
    if (!acquired) {
      throw new Error("Conflicting external AT ingestion mode is already active");
    }
    this.mode = mode;
    this.onLost = onLost;
    this.active = true;
    this.timer = setInterval(() => { void this.heartbeat(); },
      Math.max(150, Math.floor(this.ttlMs / 3)));
    this.timer.unref?.();
  }

  stop(): void {
    this.active = false;
    this.onLost = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Never delete the shared mode key: another replica may be renewing it.
    // Keep the conservative TTL after all replicas stop before switching mode.
  }

  private async checkMode(mode: ExternalAtIngestionSource): Promise<boolean> {
    const result = await withRedisFenceDeadline(
      this.redis.eval(MATCH_MODE, 1, this.key,
        mode, String(this.ttlMs)),
      Math.max(200, Math.min(4000, Math.floor(this.ttlMs / 3))),
    );
    if (result !== 0 && result !== 1) {
      throw new Error("Unexpected external ingestion mode response");
    }
    return result === 1;
  }

  private async heartbeat(): Promise<void> {
    if (!this.active || this.refreshing) return;
    this.refreshing = true;
    try {
      const ok = await this.checkMode(this.mode);
      if (!ok) this.failClosed();
    } catch {
      this.failClosed();
    } finally {
      this.refreshing = false;
    }
  }

  private failClosed(): void {
    if (!this.active) return;
    const notify = this.onLost;
    this.stop();
    notify?.();
  }
}
