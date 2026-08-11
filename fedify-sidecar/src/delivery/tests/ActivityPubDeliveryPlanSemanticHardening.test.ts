import { describe, expect, it } from "vitest";
import { safeParseActivityPubDeliveryPlanV1 } from "../ActivityPubDeliveryPlanContract.js";

const activityId = "https://pods.example/alice/activities/semantic";
const actorUri = "https://pods.example/alice";

function basePlan() {
  return {
    schema: "ap.delivery-plan.v1",
    intentId: "apdm-v1-a34b1fdd77e98965f6aab4ad45a5cf118fa78087cca74f6fe06dd659cfeb0dad",
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
  it("rejects metadata visibility that disagrees with Activity addressing", () => {
    const plan = basePlan();
    expect(safeParseActivityPubDeliveryPlanV1({
      ...plan,
      meta: { visibility: "direct", isPublicActivity: false },
    }).success).toBe(false);
  });

  it("rejects embedded credentials in actor and inbox URLs", () => {
    const plan = basePlan();
    expect(safeParseActivityPubDeliveryPlanV1({
      ...plan,
      actorUri: "https://user:secret@pods.example/alice",
    }).success).toBe(false);
  });
});
