import { describe, expect, it, vi } from "vitest";
import { EntrywayRecoveryWorker } from "../EntrywayRecoveryWorker.js";

describe("EntrywayRecoveryWorker", () => {
  it("runs one bounded recovery pass", async () => {
    const recoverStaleProvisioning = vi.fn().mockResolvedValue({
      recovered: 1,
      failed: 0,
      skipped: 2,
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const worker = new EntrywayRecoveryWorker(
      { recoverStaleProvisioning } as any,
      { intervalMs: 60_000, batchLimit: 25 },
      logger,
    );

    const result = await worker.runOnce();

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 2 });
    expect(recoverStaleProvisioning).toHaveBeenCalledWith(25);
    expect(logger.info).toHaveBeenCalledWith("Entryway recovery pass completed", result);
  });

  it("does not overlap recovery passes", async () => {
    let resolveRecovery: ((value: unknown) => void) | undefined;
    const recoverStaleProvisioning = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRecovery = resolve;
    }));
    const worker = new EntrywayRecoveryWorker(
      { recoverStaleProvisioning } as any,
      { intervalMs: 60_000, batchLimit: 25 },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    const first = worker.runOnce();
    const second = await worker.runOnce();
    resolveRecovery?.({ recovered: 0, failed: 0, skipped: 0 });
    await first;

    expect(second).toBeNull();
    expect(recoverStaleProvisioning).toHaveBeenCalledTimes(1);
  });
});
