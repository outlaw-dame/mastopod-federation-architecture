import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlledActivityPubTargetState } from "../ControlledActivityPubTarget.js";
import { AdspRemoteFixtureRunner } from "../RemoteFixtureRunner.js";

function emptySnapshot() {
  return {
    version: 1 as const,
    transientFailuresBeforeSuccess: 2,
    maxObservations: 100,
    totalRequests: 0,
    droppedObservations: 0,
    counts: { success: 0, transient: 0, permanent: 0 },
    observations: [],
  };
}

function completedSnapshot(activityId: string) {
  const state = new ControlledActivityPubTargetState();
  const body = JSON.stringify({ id: activityId, type: "Create" });
  state.handle({
    scenario: "success",
    method: "POST",
    path: "/inbox/success",
    headers: {
      "content-type": "application/activity+json",
      date: "Mon, 17 Aug 2026 21:00:00 GMT",
      digest: `SHA-256=${createHash("sha256").update(body).digest("base64")}`,
      signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
    },
    body: Buffer.from(body),
    nowMs: 1_000,
  });
  return state.snapshot();
}

function input() {
  const activityId = "https://pods.example/alice/activities/runner";
  return {
    scenario: "success" as const,
    jobId: `${activityId}::http://127.0.0.1:18080/inbox/success`,
    handoff: {
      deliveryPlanIntentId: `apdm-v1-${"a".repeat(64)}`,
      actorUri: "https://pods.example/alice",
      activityId,
      activity: {
        id: activityId,
        type: "Create",
        actor: "https://pods.example/alice",
      },
      target: { inboxUrl: "http://127.0.0.1:18080/inbox/success" },
    },
    settlement: {
      timeoutMs: 1_000,
      initialDelayMs: 10,
      maxDelayMs: 10,
      sleep: async () => undefined,
    },
  };
}

describe("AdspRemoteFixtureRunner", () => {
  it("orders reset, clean baseline, durable handoff, and settlement without inventing worker state", async () => {
    const value = input();
    const target = {
      reset: vi.fn().mockResolvedValue(undefined),
      readSnapshot: vi.fn()
        .mockResolvedValueOnce(emptySnapshot())
        .mockResolvedValue(completedSnapshot(value.handoff.activityId)),
    };
    const observer = {
      captureBaseline: vi.fn().mockResolvedValue({ outboundDlqLength: 0 }),
      observe: vi.fn().mockResolvedValue({
        outboxIntentCompleted: true,
        outboxIntentJobCount: 1,
        deliveryCompleted: true,
        outboundDlqDelta: 0,
        outboundPendingCount: 0,
      }),
    };
    const handoff = {
      enqueue: vi.fn().mockResolvedValue({
        accepted: true,
        intentId: value.handoff.deliveryPlanIntentId,
        jobCount: 1,
      }),
    };
    const runner = new AdspRemoteFixtureRunner(handoff as any, observer as any, target as any);

    const result = await runner.run(value);

    expect(result.reconciliation.complete).toBe(true);
    expect(result.reconciliation.activityId).toBe(value.handoff.activityId);
    expect(target.reset).toHaveBeenCalledTimes(1);
    expect(observer.captureBaseline).toHaveBeenCalledTimes(1);
    expect(handoff.enqueue).toHaveBeenCalledExactlyOnceWith(value.handoff);
    expect(observer.observe).toHaveBeenCalledWith(expect.objectContaining({
      intentId: value.handoff.deliveryPlanIntentId,
      jobId: value.jobId,
      baseline: { outboundDlqLength: 0 },
    }));

    const resetOrder = target.reset.mock.invocationCallOrder[0] ?? 0;
    const baselineOrder = observer.captureBaseline.mock.invocationCallOrder[0] ?? 0;
    const enqueueOrder = handoff.enqueue.mock.invocationCallOrder[0] ?? 0;
    expect(resetOrder).toBeLessThan(baselineOrder);
    expect(baselineOrder).toBeLessThan(enqueueOrder);
  });

  it("refuses an activity identity mismatch before touching target or queue state", async () => {
    const value = input();
    value.handoff.activity = { ...value.handoff.activity, id: "https://pods.example/other" };
    const target = { reset: vi.fn(), readSnapshot: vi.fn() };
    const observer = { captureBaseline: vi.fn(), observe: vi.fn() };
    const handoff = { enqueue: vi.fn() };
    const runner = new AdspRemoteFixtureRunner(handoff as any, observer as any, target as any);

    await expect(runner.run(value)).rejects.toThrow(/activity.id must exactly match/u);
    expect(target.reset).not.toHaveBeenCalled();
    expect(observer.captureBaseline).not.toHaveBeenCalled();
    expect(handoff.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to enqueue when target reset did not produce an empty ledger", async () => {
    const value = input();
    const dirty = completedSnapshot(value.handoff.activityId);
    const target = {
      reset: vi.fn().mockResolvedValue(undefined),
      readSnapshot: vi.fn().mockResolvedValue(dirty),
    };
    const observer = { captureBaseline: vi.fn(), observe: vi.fn() };
    const handoff = { enqueue: vi.fn() };
    const runner = new AdspRemoteFixtureRunner(handoff as any, observer as any, target as any);

    await expect(runner.run(value)).rejects.toThrow(/empty evidence ledger/u);
    expect(observer.captureBaseline).not.toHaveBeenCalled();
    expect(handoff.enqueue).not.toHaveBeenCalled();
  });
});
