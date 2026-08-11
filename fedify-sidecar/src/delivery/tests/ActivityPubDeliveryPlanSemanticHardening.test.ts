import { describe, expect, it } from "vitest";
import { safeParseActivityPubDeliveryPlanV1 } from "../ActivityPubDeliveryPlanContract.js";

const activityId = "https://pods.example/alice/activities/semantic";
const actorUri = "https://pods.example/alice";

function basePlan() {
  return {
    schema: "ap.delivery-plan.v1",
    intentId: "apdm-v1-06f6dd74286e7c9343a40612322df9cfab7359de51ee2ce3b39a75cd8665df41",
    activityId,
    actorUri,
    activity: {
      id: activityId,
      actor: actorUri,
      type: "Create",
      to: ["https://pods.example/alice/followers"],
      cc: [],
    },
    localRecipients: [],
    remoteRecipients: [],
    meta: { visibility: "followers", isPublicActivity: false },
  };
}

describe("APDM Phase 3 semantic hardening regressions", () => {
  it("starts from a semantically valid baseline", () => {
    expect(safeParseActivityPubDeliveryPlanV1(basePlan()).success).toBe(true);
  });

  it("rejects metadata visibility that disagrees with Activity addressing", () => {
    const plan = basePlan();
    expect(safeParseActivityPubDeliveryPlanV1({
      ...plan,
      meta: { visibility: "direct", isPublicActivity: false },
    }).success).toBe(false);
  });

  it("rejects embedded credentials in actor URLs", () => {
    const plan = basePlan();
    expect(safeParseActivityPubDeliveryPlanV1({
      ...plan,
      actorUri: "https://user:secret@pods.example/alice",
    }).success).toBe(false);
  });
});
