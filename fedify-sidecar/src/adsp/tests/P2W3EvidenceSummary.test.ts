import { describe, expect, it } from "vitest";
import {
  ADSP_P2_W3_CORRELATION_SCHEMA,
  ADSP_P2_W3_REPLICA_COUNTS,
  ADSP_P2_W3_SCENARIOS,
  ADSP_P2_W3_SUMMARY_SCHEMA,
  summarizeAdspP2W3Evidence,
  validateAdspP2W3Case,
  type AdspP2W3CaseEvidence,
  type AdspP2W3ReplicaCount,
  type AdspP2W3Scenario,
} from "../P2W3EvidenceSummary.js";

function syntheticIntentId(suffix: string): string {
  const hex = Buffer.from(suffix, "utf8").toString("hex");
  return `sha256:${hex.padEnd(64, "0").slice(0, 64)}`;
}

function makeCase(replicas: AdspP2W3ReplicaCount, scenario: AdspP2W3Scenario): AdspP2W3CaseEvidence {
  const suffix = `${replicas}-${scenario}`;
  const activityId = `https://pods.example/alice/as/activity/${suffix}`;
  const actorUri = "https://pods.example/alice";
  const intentId = syntheticIntentId(suffix);
  const inboxUrl = `http://127.0.0.1:18080/inbox/${scenario}`;
  return {
    replicas,
    scenario,
    origin: {
      ok: true,
      schema: "adsp.p0.activitypods-remote-origin.v1",
      activityId,
      actorUri,
      activity: {
        id: activityId,
        type: "Create",
        actor: actorUri,
        to: [`http://127.0.0.1:18080/actor/${scenario}`],
      },
      deliveryPlanSchema: "ap.delivery-plan.v1",
      deliveryPlanIntentId: intentId,
      remoteActorUri: `http://127.0.0.1:18080/actor/${scenario}`,
      inboxUrl,
      targetDomain: "127.0.0.1",
      visibility: "unlisted",
      isPublicActivity: true,
      suppressedNativeRemotePostCount: 1,
      durableHandoffQueued: true,
      senderUsername: `alice-${suffix}`,
    },
    correlation: {
      schema: ADSP_P2_W3_CORRELATION_SCHEMA,
      requestId: `request-${suffix}`,
      activityId,
      moleculerNamespace: `adsp-p2-w3-${replicas}r`,
      expectedReplicas: replicas,
    },
    settlement: {
      ok: true,
      schema: "adsp.p0.activitypods-origin-settlement.v1",
      scenario,
      activityId,
      intentId,
      jobId: `${activityId}::${inboxUrl}`,
      eventLogPublishedAt: 1_780_000_000_000 + replicas,
      observedBodySha256: "b".repeat(64),
      observedRequests: scenario === "transient" ? 3 : 1,
      errors: [],
    },
  };
}

function allCases(): AdspP2W3CaseEvidence[] {
  return ADSP_P2_W3_REPLICA_COUNTS.flatMap(replicas =>
    ADSP_P2_W3_SCENARIOS.map(scenario => makeCase(replicas, scenario)),
  );
}

describe("ADSP P2 W3 evidence summary", () => {
  it("accepts exactly one complete success/transient/permanent set for each 1/2/4 arm", () => {
    const summary = summarizeAdspP2W3Evidence(allCases());
    expect(summary.schema).toBe(ADSP_P2_W3_SUMMARY_SCHEMA);
    expect(summary.complete).toBe(true);
    expect(summary.cases).toHaveLength(9);
    expect(summary.cases.map(item => `${item.replicas}/${item.scenario}`)).toEqual([
      "1/success",
      "1/transient",
      "1/permanent",
      "2/success",
      "2/transient",
      "2/permanent",
      "4/success",
      "4/transient",
      "4/permanent",
    ]);
  });

  it("fails closed on Activity, intent, job, scenario, request-count, or replica-correlation drift", () => {
    const activityDrift = makeCase(2, "success");
    (activityDrift.correlation as Record<string, unknown>)["activityId"] = "https://pods.example/wrong";
    expect(() => validateAdspP2W3Case(activityDrift)).toThrow(/Activity identity drift/u);

    const intentDrift = makeCase(2, "success");
    (intentDrift.settlement as Record<string, unknown>)["intentId"] = "different-intent";
    expect(() => validateAdspP2W3Case(intentDrift)).toThrow(/intent drift/u);

    const jobDrift = makeCase(2, "success");
    (jobDrift.settlement as Record<string, unknown>)["jobId"] = "wrong-job";
    expect(() => validateAdspP2W3Case(jobDrift)).toThrow(/job identity drift/u);

    const scenarioDrift = makeCase(2, "success");
    (scenarioDrift.settlement as Record<string, unknown>)["scenario"] = "transient";
    expect(() => validateAdspP2W3Case(scenarioDrift)).toThrow(/scenario drift/u);

    const requestCountDrift = makeCase(2, "transient");
    (requestCountDrift.settlement as Record<string, unknown>)["observedRequests"] = 2;
    expect(() => validateAdspP2W3Case(requestCountDrift)).toThrow(/request count drift/u);

    const replicaDrift = makeCase(2, "success");
    (replicaDrift.correlation as Record<string, unknown>)["expectedReplicas"] = 4;
    expect(() => validateAdspP2W3Case(replicaDrift)).toThrow(/replica count drift/u);
  });

  it("rejects failed reconciliation, missing RedPanda proof, wrong schema, malformed digest, or unsupported fields", () => {
    const reconciliationError = makeCase(1, "success");
    (reconciliationError.settlement as Record<string, unknown>)["errors"] = ["duplicate delivery"];
    expect(() => validateAdspP2W3Case(reconciliationError)).toThrow(/errors must be an empty array/u);

    const noRedPanda = makeCase(1, "success");
    (noRedPanda.settlement as Record<string, unknown>)["eventLogPublishedAt"] = 0;
    expect(() => validateAdspP2W3Case(noRedPanda)).toThrow(/eventLogPublishedAt/u);

    const wrongSchema = makeCase(1, "success");
    (wrongSchema.settlement as Record<string, unknown>)["schema"] = "adsp.p0.wrong.v1";
    expect(() => validateAdspP2W3Case(wrongSchema)).toThrow(/settlement schema/u);

    const malformedDigest = makeCase(1, "success");
    (malformedDigest.settlement as Record<string, unknown>)["observedBodySha256"] = "not-a-digest";
    expect(() => validateAdspP2W3Case(malformedDigest)).toThrow(/SHA-256 digest/u);

    const unsupported = makeCase(1, "success");
    (unsupported.settlement as Record<string, unknown>)["extra"] = true;
    expect(() => validateAdspP2W3Case(unsupported)).toThrow(/unsupported field/u);
  });

  it("requires all nine unique coordinates and unique authoritative identities", () => {
    const missing = allCases().slice(0, 8);
    expect(() => summarizeAdspP2W3Evidence(missing)).toThrow(/exactly nine/u);

    const duplicateCoordinate = allCases();
    duplicateCoordinate[8] = makeCase(4, "transient");
    expect(() => summarizeAdspP2W3Evidence(duplicateCoordinate)).toThrow(/duplicate evidence coordinate/u);

    const duplicateActivity = allCases();
    const source = duplicateActivity[0]!;
    const target = duplicateActivity[1]!;
    const activityId = (source.origin as Record<string, unknown>)["activityId"] as string;
    const inboxUrl = (target.origin as Record<string, unknown>)["inboxUrl"] as string;
    (target.origin as Record<string, unknown>)["activityId"] = activityId;
    ((target.origin as Record<string, unknown>)["activity"] as Record<string, unknown>)["id"] = activityId;
    (target.correlation as Record<string, unknown>)["activityId"] = activityId;
    (target.settlement as Record<string, unknown>)["activityId"] = activityId;
    (target.settlement as Record<string, unknown>)["jobId"] = `${activityId}::${inboxUrl}`;
    expect(() => summarizeAdspP2W3Evidence(duplicateActivity)).toThrow(/duplicate Activity identity/u);
  });

  it("requires one matched namespace per arm and distinct namespaces across replica arms", () => {
    const cases = allCases();
    const changed = cases.find(item => item.replicas === 4 && item.scenario === "permanent")!;
    (changed.correlation as Record<string, unknown>)["moleculerNamespace"] = "different-namespace";
    expect(() => summarizeAdspP2W3Evidence(cases)).toThrow(/must share one matched Moleculer namespace/u);

    const reused = allCases();
    for (const item of reused.filter(item => item.replicas === 4)) {
      (item.correlation as Record<string, unknown>)["moleculerNamespace"] = "adsp-p2-w3-2r";
    }
    expect(() => summarizeAdspP2W3Evidence(reused)).toThrow(/replica arms must use distinct Moleculer namespaces/u);
  });
});
