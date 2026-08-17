import type { ControlledTargetSnapshot } from "./ControlledActivityPubTarget.js";
import type {
  AdspRemoteDurableBaseline,
  AdspRemoteFixtureDurableObserver,
} from "./RemoteFixtureDurableObserver.js";
import {
  reconcileAdspRemoteFixtureOutcome,
  type AdspRemoteFixtureExpectation,
  type AdspRemoteFixtureReconciliation,
} from "./RemoteFixtureOutcomeReconciler.js";

export interface AdspRemoteTargetSnapshotPort {
  readSnapshot(): Promise<ControlledTargetSnapshot>;
}

export interface AdspRemoteSettlementOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2_000;

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export class AdspRemoteFixtureSettlementTimeoutError extends Error {
  constructor(
    public readonly reconciliation: AdspRemoteFixtureReconciliation,
    timeoutMs: number,
  ) {
    super(
      `ADSP remote fixture did not settle within ${timeoutMs} ms: ${reconciliation.errors.join("; ") || "no complete reconciliation"}`,
    );
    this.name = "AdspRemoteFixtureSettlementTimeoutError";
  }
}

export async function waitForAdspRemoteFixtureSettlement(input: {
  observer: Pick<AdspRemoteFixtureDurableObserver, "observe">;
  target: AdspRemoteTargetSnapshotPort;
  expectation: AdspRemoteFixtureExpectation;
  intentId: string;
  jobId: string;
  baseline: AdspRemoteDurableBaseline;
  options?: AdspRemoteSettlementOptions;
}): Promise<AdspRemoteFixtureReconciliation> {
  const options = input.options ?? {};
  const timeoutMs = positiveSafeInteger(
    "timeoutMs",
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const initialDelayMs = positiveSafeInteger(
    "initialDelayMs",
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
  );
  const maxDelayMs = positiveSafeInteger(
    "maxDelayMs",
    options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  );
  if (initialDelayMs > maxDelayMs) {
    throw new TypeError("initialDelayMs must not exceed maxDelayMs");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let delayMs = initialDelayMs;
  let lastReconciliation: AdspRemoteFixtureReconciliation | null = null;

  for (;;) {
    const [durable, targetSnapshot] = await Promise.all([
      input.observer.observe({
        intentId: input.intentId,
        jobId: input.jobId,
        baseline: input.baseline,
      }),
      input.target.readSnapshot(),
    ]);

    const reconciliation = reconcileAdspRemoteFixtureOutcome({
      expectation: input.expectation,
      target: targetSnapshot,
      durable,
    });
    lastReconciliation = reconciliation;
    if (reconciliation.complete) return reconciliation;

    const current = now();
    if (current >= deadline) {
      throw new AdspRemoteFixtureSettlementTimeoutError(reconciliation, timeoutMs);
    }

    const remainingMs = deadline - current;
    const actualDelayMs = Math.min(delayMs, remainingMs);
    await sleep(actualDelayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }

  // Defensive type-flow guard; loop exits only by return/throw.
  void lastReconciliation;
}
