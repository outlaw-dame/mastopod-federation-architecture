import type { EntrywayProvisioningService } from "./EntrywayProvisioningService.js";

export interface EntrywayRecoveryWorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EntrywayRecoveryWorkerOptions {
  intervalMs: number;
  initialDelayMs?: number;
  batchLimit: number;
}

export class EntrywayRecoveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  public constructor(
    private readonly service: EntrywayProvisioningService,
    private readonly options: EntrywayRecoveryWorkerOptions,
    private readonly logger: EntrywayRecoveryWorkerLogger,
  ) {}

  public start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    const initialDelayMs = clampInteger(this.options.initialDelayMs ?? this.options.intervalMs, 1_000, 60 * 60_000);
    this.timer = setTimeout(() => {
      void this.tick();
    }, initialDelayMs);
    this.timer.unref?.();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.running) {
      await sleep(25);
    }
  }

  public async runOnce(): Promise<{ recovered: number; failed: number; skipped: number } | null> {
    if (this.running) {
      return null;
    }

    this.running = true;
    try {
      const result = await this.service.recoverStaleProvisioning(this.options.batchLimit);
      if (result.recovered || result.failed || result.skipped) {
        this.logger.info("Entryway recovery pass completed", result);
      }
      return result;
    } catch (error) {
      this.logger.error("Entryway recovery pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    await this.runOnce();

    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, clampInteger(this.options.intervalMs, 5_000, 60 * 60_000));
    this.timer.unref?.();
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
