import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ControlledActivityPubTargetState } from "../ControlledActivityPubTarget.js";
import { reconcileAdspRemoteFixtureOutcome } from "../RemoteFixtureOutcomeReconciler.js";

function signedHeaders(body: string): Record<string, string> {
  return {
    host: "127.0.0.1:18080",
    date: "Mon, 17 Aug 2026 21:00:00 GMT",
    digest: `SHA-256=${createHash("sha256").update(body).digest("base64")}`,
    signature: 'keyId="https://pods.example/alice#main-key",signature="abc"',
    "content-type": "application/activity+json",
  };
}

function hit(
  state: ControlledActivityPubTargetState,
  scenario: "success" | "transient" | "permanent",
  body: string,
) {
  return state.handle({
    scenario,
    method: "POST",
    path: `/inbox/${scenario}`,
    headers: signedHeaders(body),
    body: Buffer.from(body),
    nowMs: 1_000,
  });
}

function durable(overrides: Partial<{
  outboxIntentCompleted: boolean;
  outboxIntentJobCount: number | null;
  deliveryCompleted: boolean;
  outboundDlqDelta: number;
  outboundPendingCount: number;
}> = {}) {
  return {
    outboxIntentCompleted: true,
    outboxIntentJobCount: 1,
    deliveryCompleted: true,
    outboundDlqDelta: 0,
    outboundPendingCount: 0,
    ...overrides,
  };
}

describe("reconcileAdspRemoteFixtureOutcome", () => {
  it("accepts a single successful signed delivery only after durable completion", () => {
    const state = new ControlledActivityPubTargetState();
    const body = '{"id":"https://pods.example/activities/success"}';
    expect(hit(state, "success", body).statusCode).toBe(202);

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "success", activityId: "https://pods.example/activities/success" },
      target: state.snapshot(),
      durable: durable(),
    });

    expect(result).toEqual(expect.objectContaining({
      complete: true,
      activityId: "https://pods.example/activities/success",
      observedRequests: 1,
      errors: [],
    }));
    expect(result.observedBodySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts transient retry only when every configured failure is followed by exactly one success", () => {
    const state = new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: 2 });
    const body = '{"id":"https://pods.example/activities/transient"}';
    expect(hit(state, "transient", body).statusCode).toBe(503);
    expect(hit(state, "transient", body).statusCode).toBe(503);
    expect(hit(state, "transient", body).statusCode).toBe(202);

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "transient", activityId: "https://pods.example/activities/transient" },
      target: state.snapshot(),
      durable: durable(),
    });

    expect(result.complete).toBe(true);
    expect(result.observedRequests).toBe(3);
  });

  it("rejects an extra successful redelivery after transient completion", () => {
    const state = new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: 1 });
    const body = '{"id":"https://pods.example/activities/duplicate"}';
    expect(hit(state, "transient", body).statusCode).toBe(503);
    expect(hit(state, "transient", body).statusCode).toBe(202);
    expect(hit(state, "transient", body).statusCode).toBe(202);

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "transient", activityId: "https://pods.example/activities/duplicate" },
      target: state.snapshot(),
      durable: durable(),
    });

    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toMatch(/expected exactly 2 remote request/u);
  });

  it("rejects retries whose Activity id is stable but body bytes change", () => {
    const state = new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: 1 });
    const activityId = "https://pods.example/activities/mutated-retry";
    expect(hit(state, "transient", JSON.stringify({ id: activityId, object: { content: "first" } })).statusCode).toBe(503);
    expect(hit(state, "transient", JSON.stringify({ id: activityId, object: { content: "changed" } })).statusCode).toBe(503);

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "transient", activityId, transientFailuresBeforeSuccess: 1 },
      target: state.snapshot(),
      durable: durable(),
    });

    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toMatch(/immutable ActivityPub body bytes/u);
    expect(result.errors.join(" ")).toMatch(/payload attempt sequence/u);
  });

  it("rejects an observation whose Digest is not proven against the exact body", () => {
    const state = new ControlledActivityPubTargetState();
    const activityId = "https://pods.example/activities/digest-evidence";
    hit(state, "success", JSON.stringify({ id: activityId }));
    const snapshot = state.snapshot();
    snapshot.observations[0]!.hasValidDigest = false;

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "success", activityId },
      target: snapshot,
      durable: durable(),
    });

    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Digest that does not match/u);
  });

  it("accepts permanent failure only when exactly one HTTP attempt is durably dead-lettered", () => {
    const state = new ControlledActivityPubTargetState();
    const activityId = "https://pods.example/activities/gone";
    expect(hit(state, "permanent", JSON.stringify({ id: activityId })).statusCode).toBe(410);

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "permanent", activityId },
      target: state.snapshot(),
      durable: durable({
        deliveryCompleted: false,
        outboundDlqDelta: 1,
      }),
    });

    expect(result.complete).toBe(true);
  });

  it("fails closed when public durable queue state contradicts the observed outcome", () => {
    const state = new ControlledActivityPubTargetState();
    const activityId = "https://pods.example/activities/contradiction";
    hit(state, "success", JSON.stringify({ id: activityId }));

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "success", activityId },
      target: state.snapshot(),
      durable: durable({
        outboxIntentCompleted: false,
        outboxIntentJobCount: null,
        deliveryCompleted: false,
        outboundDlqDelta: 1,
        outboundPendingCount: 1,
      }),
    });

    expect(result.complete).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("outbox intent is not durably completed"),
      expect.stringContaining("jobCount=1"),
      expect.stringContaining("no pending outbound entries"),
      expect.stringContaining("missing its durable completed marker"),
      expect.stringContaining("changed outbound DLQ by 1"),
    ]));
  });

  it("fails closed if controlled-target evidence was truncated", () => {
    const state = new ControlledActivityPubTargetState({ maxObservations: 1 });
    const activityId = "https://pods.example/activities/bounded";
    hit(state, "success", JSON.stringify({ id: activityId }));
    hit(state, "success", '{"id":"https://pods.example/activities/other"}');

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "success", activityId },
      target: state.snapshot(),
      durable: durable(),
    });

    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toMatch(/exact reconciliation is impossible/u);
  });

  it("rejects malformed transient completion expectations", () => {
    const state = new ControlledActivityPubTargetState({ transientFailuresBeforeSuccess: 0 });
    const activityId = "https://pods.example/activities/bad-config";
    hit(state, "transient", JSON.stringify({ id: activityId }));

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: {
        scenario: "transient",
        activityId,
        transientFailuresBeforeSuccess: -1,
      },
      target: state.snapshot(),
      durable: durable(),
    });

    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toMatch(/non-negative safe integer/u);
  });

  it("rejects malformed queue counters instead of normalizing them away", () => {
    const state = new ControlledActivityPubTargetState();
    const activityId = "https://pods.example/activities/bad-counters";
    hit(state, "success", JSON.stringify({ id: activityId }));

    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "success", activityId },
      target: state.snapshot(),
      durable: durable({ outboundDlqDelta: -1, outboundPendingCount: -1 }),
    });

    expect(result.complete).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("outboundDlqDelta must be a non-negative safe integer"),
      expect.stringContaining("outboundPendingCount must be a non-negative safe integer"),
    ]));
  });

  it("rejects an empty or padded Activity identity", () => {
    const state = new ControlledActivityPubTargetState();
    const result = reconcileAdspRemoteFixtureOutcome({
      expectation: { scenario: "success", activityId: " padded " },
      target: state.snapshot(),
      durable: durable(),
    });
    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toMatch(/activityId must be a non-empty exact string/u);
  });
});
