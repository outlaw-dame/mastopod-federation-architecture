import { describe, expect, it } from "vitest";
import {
  expectedOutboundJobIdFromOrigin,
  parseActivityPodsOriginEvidence,
  parseAdspRemoteObservationConfig,
  parsePreparedRemoteOriginEvidence,
} from "../RemoteFixtureActivityPodsOrigin.js";
import { assertActivityPodsOriginMatchesControlledScenario } from "../RemoteFixtureControlledOriginBinding.js";

const activityId = "https://pods.example/alice/as/activity/1";
const actorUri = "https://pods.example/alice";

function origin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    schema: "adsp.p0.activitypods-remote-origin.v1",
    activityId,
    actorUri,
    activity: {
      id: activityId,
      type: "Create",
      actor: actorUri,
      to: ["http://127.0.0.1:18080/actor/success"],
      cc: ["https://www.w3.org/ns/activitystreams#Public"],
      object: { type: "Note", content: "fixture" },
    },
    deliveryPlanSchema: "ap.delivery-plan.v1",
    deliveryPlanIntentId: `apdm-v1-${"a".repeat(64)}`,
    remoteActorUri: "http://127.0.0.1:18080/actor/success",
    inboxUrl: "http://127.0.0.1:18080/inbox/success",
    sharedInboxUrl: "http://127.0.0.1:18080/inbox/success",
    targetDomain: "127.0.0.1",
    visibility: "unlisted",
    isPublicActivity: true,
    suppressedNativeRemotePostCount: 1,
    durableHandoffQueued: true,
    senderUsername: "alice",
    ...overrides,
  };
}

describe("ActivityPods-origin ADSP boundary", () => {
  it("parses the exact observation coordinates without requiring sidecar handoff credentials", () => {
    expect(parseAdspRemoteObservationConfig({
      ADSP_REMOTE_REDIS_URL: "redis://127.0.0.1:6379",
      ADSP_REMOTE_TARGET_STATS_URL: "http://127.0.0.1:18080/stats",
      ADSP_REMOTE_CONSUMER_GROUP: "sidecar-workers",
      ADSP_REMOTE_INBOUND_STREAM_KEY: "ap:queue:inbound:v1",
      ADSP_REMOTE_OUTBOUND_STREAM_KEY: "ap:queue:outbound:v1",
      ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY: "ap:queue:outbox-intent:v1",
      ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY: "ap:queue:origin-reconcile:v1",
      ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY: "ap:queue:dlq:outbound:v1",
    })).toEqual({
      redisUrl: "redis://127.0.0.1:6379",
      targetStatsUrl: "http://127.0.0.1:18080/stats",
      consumerGroup: "sidecar-workers",
      inboundStreamKey: "ap:queue:inbound:v1",
      outboundStreamKey: "ap:queue:outbound:v1",
      outboxIntentStreamKey: "ap:queue:outbox-intent:v1",
      originReconcileStreamKey: "ap:queue:origin-reconcile:v1",
      outboundDlqStreamKey: "ap:queue:dlq:outbound:v1",
    });
  });

  it("accepts only public/unlisted ActivityPods authority with exact actor and target binding", () => {
    const parsed = parseActivityPodsOriginEvidence(origin());
    expect(parsed.activityId).toBe(activityId);
    expect(parsed.actorUri).toBe(actorUri);
    expect(parsed.visibility).toBe("unlisted");
    expect(parsed.isPublicActivity).toBe(true);
    expect(parsed.targetDomain).toBe("127.0.0.1");
  });

  it("fails closed when the origin would bypass RedPanda, actor authority drifts, or targetDomain is inconsistent", () => {
    for (const value of [
      origin({ visibility: "direct", isPublicActivity: false }),
      origin({ actorUri: "https://pods.example/mallory" }),
      origin({ targetDomain: "127.0.0.1:18080" }),
    ]) {
      expect(() => parseActivityPodsOriginEvidence(value)).toThrow();
    }
  });

  it("rejects unexpected origin fields instead of silently accepting contract drift", () => {
    expect(() => parseActivityPodsOriginEvidence(origin({ unexpected: true }))).toThrow(/unsupported field/u);
  });

  it("binds valid authority to the exact controlled actor and delivery inbox for the requested scenario", () => {
    const parsed = parseActivityPodsOriginEvidence(origin());
    expect(() => assertActivityPodsOriginMatchesControlledScenario({
      origin: parsed,
      scenario: "success",
      targetStatsUrl: "http://127.0.0.1:18080/stats",
    })).not.toThrow();

    expect(() => assertActivityPodsOriginMatchesControlledScenario({
      origin: parsed,
      scenario: "transient",
      targetStatsUrl: "http://127.0.0.1:18080/stats",
    })).toThrow(/controlled scenario actor/u);

    const wrongInbox = parseActivityPodsOriginEvidence(origin({
      inboxUrl: "http://127.0.0.1:18080/inbox/permanent",
      sharedInboxUrl: "http://127.0.0.1:18080/inbox/permanent",
    }));
    expect(() => assertActivityPodsOriginMatchesControlledScenario({
      origin: wrongInbox,
      scenario: "success",
      targetStatsUrl: "http://127.0.0.1:18080/stats",
    })).toThrow(/controlled scenario inbox/u);
  });

  it("uses the sidecar-normalized shared inbox for the production worker job identity", () => {
    const parsed = parseActivityPodsOriginEvidence(origin({
      inboxUrl: "http://127.0.0.1:18080/inbox/personal",
      sharedInboxUrl: "http://127.0.0.1:18080/inbox/shared",
    }));
    expect(expectedOutboundJobIdFromOrigin(parsed)).toBe(
      `${activityId}::http://127.0.0.1:18080/inbox/shared`,
    );
  });

  it("validates the prepared baseline as an exact non-negative durable snapshot", () => {
    expect(parsePreparedRemoteOriginEvidence({
      schema: "adsp.p0.remote-origin-prepared.v1",
      baseline: { outboundDlqLength: 3 },
    })).toEqual({
      schema: "adsp.p0.remote-origin-prepared.v1",
      baseline: { outboundDlqLength: 3 },
    });

    expect(() => parsePreparedRemoteOriginEvidence({
      schema: "adsp.p0.remote-origin-prepared.v1",
      baseline: { outboundDlqLength: -1 },
    })).toThrow(/non-negative safe integer/u);
  });
});
