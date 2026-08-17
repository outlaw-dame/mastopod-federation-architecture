import { describe, expect, it } from "vitest";
import { parseAdspRemoteFixtureCase } from "../RemoteFixtureCase.js";

function validCase() {
  const activityId = "https://pods.example/alice/activities/1";
  return {
    scenario: "transient",
    jobId: `${activityId}::http://127.0.0.1:18080/inbox/transient`,
    transientFailuresBeforeSuccess: 2,
    handoff: {
      deliveryPlanIntentId: `apdm-v1-${"a".repeat(64)}`,
      actorUri: "https://pods.example/alice",
      activityId,
      activity: { id: activityId, type: "Create", actor: "https://pods.example/alice" },
      target: { inboxUrl: "http://127.0.0.1:18080/inbox/transient" },
      meta: { visibility: "followers" },
    },
  };
}

describe("parseAdspRemoteFixtureCase", () => {
  it("parses an explicit case without deriving authority or worker identity", () => {
    expect(parseAdspRemoteFixtureCase(validCase())).toEqual(validCase());
  });

  it("rejects unsupported fields so fixture semantics cannot silently expand", () => {
    const value = { ...validCase(), hiddenOverride: true };
    expect(() => parseAdspRemoteFixtureCase(value)).toThrow(/unsupported field/u);

    const nested = validCase() as any;
    nested.handoff.target.extra = "ignored";
    expect(() => parseAdspRemoteFixtureCase(nested)).toThrow(/unsupported field/u);
  });

  it("rejects transient configuration on non-transient scenarios", () => {
    const value = validCase();
    value.scenario = "success";
    expect(() => parseAdspRemoteFixtureCase(value)).toThrow(/allowed only for the transient scenario/u);
  });

  it("rejects numeric strings and padded identifiers", () => {
    const numeric = validCase() as any;
    numeric.transientFailuresBeforeSuccess = "2";
    expect(() => parseAdspRemoteFixtureCase(numeric)).toThrow(/non-negative safe integer/u);

    const padded = validCase();
    padded.jobId = ` ${padded.jobId}`;
    expect(() => parseAdspRemoteFixtureCase(padded)).toThrow(/jobId/u);
  });
});
