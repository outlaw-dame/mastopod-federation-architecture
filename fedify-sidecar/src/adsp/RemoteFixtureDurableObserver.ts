import {
  COMPLETED_KEY_PREFIX,
  LEGACY_COMPLETED_KEY_PREFIX,
} from "../delivery/outbound-delivery-claims.js";
import type { AdspRemoteDurableOutcome } from "./RemoteFixtureOutcomeReconciler.js";

export interface AdspRemoteQueueObservationPort {
  getOutboxIntentState(intentId: string): Promise<{
    completedAt?: number;
    jobCount?: number;
  }>;
  getPendingCount(type: "outbound" | "outbox_intent"): Promise<number>;
  getDlqLength(type: "outbound"): Promise<number>;
}

export interface AdspRemoteRedisReadPort {
  exists(key: string): Promise<number>;
}

export interface AdspRemoteDurableBaseline {
  outboundDlqLength: number;
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export class AdspRemoteFixtureDurableObserver {
  constructor(
    private readonly queue: AdspRemoteQueueObservationPort,
    private readonly redis: AdspRemoteRedisReadPort,
  ) {}

  async captureBaseline(): Promise<AdspRemoteDurableBaseline> {
    const [outboundDlqLength, outboundPending, outboxIntentPending] = await Promise.all([
      this.queue.getDlqLength("outbound"),
      this.queue.getPendingCount("outbound"),
      this.queue.getPendingCount("outbox_intent"),
    ]);
    assertNonNegativeSafeInteger("outbound DLQ baseline length", outboundDlqLength);
    assertNonNegativeSafeInteger("outbound baseline pending count", outboundPending);
    assertNonNegativeSafeInteger("outbox-intent baseline pending count", outboxIntentPending);
    if (outboundPending !== 0 || outboxIntentPending !== 0) {
      throw new Error(
        `ADSP remote fixture requires an isolated queue baseline; pending outbound=${outboundPending}, outbox_intent=${outboxIntentPending}`,
      );
    }
    return { outboundDlqLength };
  }

  async observe(input: {
    intentId: string;
    jobId: string;
    baseline: AdspRemoteDurableBaseline;
  }): Promise<AdspRemoteDurableOutcome> {
    const { intentId, jobId, baseline } = input;
    if (!intentId) throw new Error("intentId is required");
    if (!jobId) throw new Error("jobId is required");
    assertNonNegativeSafeInteger(
      "outbound DLQ baseline length",
      baseline.outboundDlqLength,
    );

    const [
      outboxIntentState,
      outboundPendingCount,
      outboundDlqLength,
      completedV2,
      completedLegacy,
    ] = await Promise.all([
      this.queue.getOutboxIntentState(intentId),
      this.queue.getPendingCount("outbound"),
      this.queue.getDlqLength("outbound"),
      this.redis.exists(`${COMPLETED_KEY_PREFIX}${jobId}`),
      this.redis.exists(`${LEGACY_COMPLETED_KEY_PREFIX}${jobId}`),
    ]);

    assertNonNegativeSafeInteger("outbound pending count", outboundPendingCount);
    assertNonNegativeSafeInteger("outbound DLQ length", outboundDlqLength);
    assertNonNegativeSafeInteger("v2 completed marker existence", completedV2);
    assertNonNegativeSafeInteger("legacy completed marker existence", completedLegacy);

    if (outboundDlqLength < baseline.outboundDlqLength) {
      throw new Error(
        `outbound DLQ length regressed from baseline ${baseline.outboundDlqLength} to ${outboundDlqLength}; isolated fixture evidence is invalid`,
      );
    }

    return {
      outboxIntentCompleted: typeof outboxIntentState.completedAt === "number",
      outboxIntentJobCount:
        typeof outboxIntentState.jobCount === "number"
          ? outboxIntentState.jobCount
          : null,
      deliveryCompleted: completedV2 > 0 || completedLegacy > 0,
      outboundDlqDelta: outboundDlqLength - baseline.outboundDlqLength,
      outboundPendingCount,
    };
  }
}
