import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlledActivityPubTargetState } from "../ControlledActivityPubTarget.js";
import {
  AdspRemoteFixtureSettlementTimeoutError,
  waitForAdspRemoteFixtureSettlement,
} from "../RemoteFixtureSettlement.js";

function targetWithSuccess(activityId: string) {
  const state = new ControlledActivityPubTargetState();
  const body = JSON.stringify({ id: activityId });
  state.handle({
    scenario: "success",
    method: "POST",
    path: "/inbox/success",
    headers: {
      host: "127.0.0.1:18080",
      date: "Mon, 17 Aug 2026 21:00:00 GMT",
      digest: `SHA-256=${createHash("sha256").update(body).digest("base64")}`,
      signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
      "content-type": "application/activity+json",
    },
    body: Buffer.from(body),
    nowMs: 1_000,
  });
  return state.snapshot();
}

function durableComplete() {
  return {
    outboxIntentCompleted: true,
    outboxIntentJobCount: 1,
    deliveryCompleted: true,
    outboundDlqDelta: 0,
    outboundPendingCount: 0,
  };
}

function durableIncomplete() {
  return {
    outboxIntentCompleted: false,
    outboxIntentJobCount: null,
    deliveryCompleted: false,
    outboundDlqDelta: 0,
    outboundPendingCount: 1,
  };
}

describe("waitForAdspRemoteFixtureSettlement", () => {
  it("polls with bounded exponential backoff until durable and remote evidence agree", async () => {
    const activityId = "https://pods.example/activities/settles";
    const observer = {
      observe: vi.fn()
        .mockResolvedValueOnce(durableIncomplete())
        .mockResolvedValueOnce(durableIncomplete())
        .mockResolvedValueOnce(durableComplete()),
    } as any;
    const target = { readSnapshot: vi.fn().mockResolvedValue(targetWithSuccess(activityId)) };
    let nowMs = 0;
    const sleeps: number[] = [];

    const result = await waitForAdspRemoteFixtureSettlement({
      observer,
      target,
      expectation: { scenario: "success", activityId },
      intentId: "intent-1",
      jobId: "job-1",
      baseline: { outboundDlqLength: 0 },
      options: {
        timeoutMs: 10_000,
        initialDelayMs: 100,
        maxDelayMs: 500,
        now: () => nowMs,
        sleep: async ms => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    });

    expect(result.complete).toBe(true);
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(target.readSnapshot).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("caps exponential backoff at maxDelayMs", async () => {
    const activityId = "https://pods.example/activities/cap";
    const observer = { observe: vi.fn().mockResolvedValue(durableIncomplete()) } as any;
    const target = { readSnapshot: vi.fn().mockResolvedValue(targetWithSuccess(activityId)) };
    let nowMs = 0;
    const sleeps: number[] = [];

    await expect(waitForAdspRemoteFixtureSettlement({
      observer,
      target,
      expectation: { scenario: "success", activityId },
      intentId: "intent-cap",
      jobId: "job-cap",
      baseline: { outboundDlqLength: 0 },
      options: {
        timeoutMs: 950,
        initialDelayMs: 100,
        maxDelayMs: 250,
        now: () => nowMs,
        sleep: async ms => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    })).rejects.toBeInstanceOf(AdspRemoteFixtureSettlementTimeoutError);

    expect(sleeps).toEqual([100, 200, 250, 250, 150]);
  });

  it("reports the final reconciliation contradictions when the hard deadline expires", async () => {
    const state = new ControlledActivityPubTargetState();
    const observer = { observe: vi.fn().mockResolvedValue(durableIncomplete()) } as any;
    const target = { readSnapshot: vi.fn().mockResolvedValue(state.snapshot()) };
    let nowMs = 0;

    let caught: unknown;
    try {
      await waitForAdspRemoteFixtureSettlement({
        observer,
        target,
        expectation: { scenario: "success", activityId: "https://pods.example/activities/never-sent" },
        intentId: "intent-timeout",
        jobId: "job-timeout",
        baseline: { outboundDlqLength: 0 },
        options: {
          timeoutMs: 100,
          initialDelayMs: 100,
          maxDelayMs: 100,
          now: () => nowMs,
          sleep: async ms => { nowMs += ms; },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdspRemoteFixtureSettlementTimeoutError);
    const timeout = caught as AdspRemoteFixtureSettlementTimeoutError;
    expect(timeout.reconciliation.complete).toBe(false);
    expect(timeout.reconciliation.errors.join(" ")).toMatch(/outbox intent is not durably completed/u);
    expect(timeout.reconciliation.errors.join(" ")).toMatch(/expected exactly 1 remote request/u);
  });

  it("rejects invalid timing configuration before touching runtime state", async () => {
    const observer = { observe: vi.fn() } as any;
    const target = { readSnapshot: vi.fn() };

    await expect(waitForAdspRemoteFixtureSettlement({
      observer,
      target,
      expectation: { scenario: "success", activityId: "https://pods.example/activities/invalid-timeout" },
      intentId: "intent",
      jobId: "job",
      baseline: { outboundDlqLength: 0 },
      options: { timeoutMs: 0 },
    })).rejects.toThrow(/timeoutMs must be a positive safe integer/u);

    await expect(waitForAdspRemoteFixtureSettlement({
      observer,
      target,
      expectation: { scenario: "success", activityId: "https://pods.example/activities/invalid-delay" },
      intentId: "intent",
      jobId: "job",
      baseline: { outboundDlqLength: 0 },
      options: { initialDelayMs: 500, maxDelayMs: 100 },
    })).rejects.toThrow(/initialDelayMs must not exceed maxDelayMs/u);

    expect(observer.observe).not.toHaveBeenCalled();
    expect(target.readSnapshot).not.toHaveBeenCalled();
  });
});
