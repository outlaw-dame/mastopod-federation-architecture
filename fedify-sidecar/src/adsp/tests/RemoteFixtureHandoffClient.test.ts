import { describe, expect, it } from "vitest";
import {
  buildAdspRemoteFixtureHandoffBody,
  normalizeFixtureSidecarWebhookUrl,
  parseAdspRemoteFixtureHandoffAcceptance,
  type AdspRemoteFixtureHandoffInput,
} from "../RemoteFixtureHandoffClient.js";

function input(): AdspRemoteFixtureHandoffInput {
  return {
    deliveryPlanIntentId: "apdm-v1-" + "a".repeat(64),
    actorUri: "https://pods.example/alice",
    activityId: "https://pods.example/alice/activities/1",
    activity: {
      id: "https://pods.example/alice/activities/1",
      type: "Create",
      actor: "https://pods.example/alice",
      object: { type: "Note", content: "hello" },
    },
    target: {
      inboxUrl: "http://127.0.0.1:18080/inbox/success",
      sharedInboxUrl: "http://127.0.0.1:18080/inbox/success",
    },
    meta: {
      visibility: "followers",
      deliveryPlanIntentId: "must-be-overridden",
      deliveryPlanSchema: "must-be-overridden",
    },
  };
}

describe("ADSP remote fixture durable handoff client contract", () => {
  it("accepts only the loopback sidecar outbox webhook", () => {
    expect(normalizeFixtureSidecarWebhookUrl("http://127.0.0.1:8080/webhook/outbox").href)
      .toBe("http://127.0.0.1:8080/webhook/outbox");
    expect(normalizeFixtureSidecarWebhookUrl("http://localhost:8080/webhook/outbox").hostname)
      .toBe("localhost");

    for (const invalid of [
      "https://127.0.0.1:8080/webhook/outbox",
      "http://10.0.0.2:8080/webhook/outbox",
      "http://example.com/webhook/outbox",
      "http://user:pass@127.0.0.1:8080/webhook/outbox",
      "http://127.0.0.1:8080/webhook/outbox#fragment",
      "http://127.0.0.1:8080/other",
    ]) {
      expect(() => normalizeFixtureSidecarWebhookUrl(invalid)).toThrow();
    }
  });

  it("constructs one authoritative APDM target and prevents metadata override", () => {
    const value = input();
    const body = buildAdspRemoteFixtureHandoffBody(value);

    expect(body).toMatchObject({
      actorUri: value.actorUri,
      activityId: value.activityId,
      remoteTargets: [
        {
          inboxUrl: value.target.inboxUrl,
          sharedInboxUrl: value.target.sharedInboxUrl,
          targetDomain: "127.0.0.1",
          apdmAuthority: {
            schema: "ap.delivery-plan.v1",
            intentId: value.deliveryPlanIntentId,
          },
        },
      ],
      meta: {
        visibility: "followers",
        deliveryPlanSchema: "ap.delivery-plan.v1",
        deliveryPlanIntentId: value.deliveryPlanIntentId,
      },
    });
  });

  it("uses personal inbox as delivery authority when shared inbox is absent", () => {
    const base = input();
    const value: AdspRemoteFixtureHandoffInput = {
      ...base,
      target: { inboxUrl: base.target.inboxUrl },
    };
    const body = buildAdspRemoteFixtureHandoffBody(value);
    expect(body.remoteTargets[0]).toEqual(expect.objectContaining({
      inboxUrl: value.target.inboxUrl,
      targetDomain: "127.0.0.1",
    }));
    expect(body.remoteTargets[0]).not.toHaveProperty("sharedInboxUrl");
  });

  it("rejects malformed authority and federation URLs before network I/O", () => {
    const whitespace = input();
    whitespace.deliveryPlanIntentId = ` ${whitespace.deliveryPlanIntentId}`;
    expect(() => buildAdspRemoteFixtureHandoffBody(whitespace)).toThrow(/deliveryPlanIntentId/u);

    const credentials = input();
    credentials.target.inboxUrl = "https://user:pass@example.com/inbox";
    expect(() => buildAdspRemoteFixtureHandoffBody(credentials)).toThrow(/credentials/u);

    const protocol = input();
    protocol.target.inboxUrl = "ftp://example.com/inbox";
    expect(() => buildAdspRemoteFixtureHandoffBody(protocol)).toThrow(/HTTP\(S\)/u);
  });

  it("accepts only explicit durable-acceptance acknowledgement shape", () => {
    expect(parseAdspRemoteFixtureHandoffAcceptance({
      accepted: true,
      intentId: "intent-1",
      jobCount: 1,
      queueingLatencyMs: 2,
    })).toEqual({ accepted: true, intentId: "intent-1", jobCount: 1 });

    for (const invalid of [
      null,
      { accepted: false, intentId: "intent-1", jobCount: 1 },
      { accepted: true, jobCount: 1 },
      { accepted: true, intentId: " intent-1", jobCount: 1 },
      { accepted: true, intentId: "intent-1", jobCount: -1 },
      { accepted: true, intentId: "intent-1", jobCount: "1" },
    ]) {
      expect(() => parseAdspRemoteFixtureHandoffAcceptance(invalid)).toThrow();
    }
  });
});
