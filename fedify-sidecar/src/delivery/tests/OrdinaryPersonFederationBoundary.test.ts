import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeDeliveryPlanValue,
  parseActivityPubDeliveryPlanV1,
  safeParseActivityPubDeliveryPlanV1,
} from "../ActivityPubDeliveryPlanContract.js";
import {
  normalizeAndDedupeOutboundTargets,
  validateApdmWebhookIdentity,
} from "../outbound-webhook.js";


/**
 * This tests the actual APDM plan/sidecar boundary with invented HTTPS origins.
 * It DOES NOT assert a remote Bonfire/Emissary/Lemmy/etc Follow was persisted.
 * It protects Person delivery from being blocked by unfinished Group controls.
 */
const sender = "https://pods.example/users/alice";
const target = (software: string) => ({
  actorUri: `https://${software}.example/users/bob`,
  inboxUrl: `https://${software}.example/users/bob/inbox`,
  targetDomain: `${software}.example`,
});
function follow(software: string, overrides: Record<string, unknown> = {}) {
  const remote = target(software);
  const activityId = sender + "/activities/follow-1";
  const material = {
    schema: "ap.delivery-plan.v1", activityId,
    actorUri: sender, localRecipientUris: [],
    remoteRecipientUris: [remote.actorUri],
  };
  const intentId = "apdm-v1-" + createHash("sha256")
    .update(canonicalizeDeliveryPlanValue(material)).digest("hex");
  return {
    schema: "ap.delivery-plan.v1",
    intentId, activityId, actorUri: sender,
    activity: {
      id: activityId, type: "Follow", actor: sender,
      object: remote.actorUri, to: [remote.actorUri],
    },
    localRecipients: [],
    remoteRecipients: [remote],
    meta: { visibility: "direct", isPublicActivity: false },
    ...overrides,
  };
}
function route(plan: ReturnType<typeof follow>) {
  const normalized = normalizeAndDedupeOutboundTargets(
    plan.remoteRecipients.map(({ actorUri: _actorUri, ...recipient }) => ({
      ...recipient,
      apdmAuthority: { schema: "ap.delivery-plan.v1", intentId: plan.intentId },
    })),
    { maxTargetsPerRequest: 100, maxPending: 1000, maxQueueDepth: 0, retryAfterSeconds: 5 }
  );
  return {
    normalized,
    identity: validateApdmWebhookIdentity({
      normalizedTargets: normalized, headerIntentId: plan.intentId,
      meta: { deliveryPlanSchema: plan.schema, deliveryPlanIntentId: plan.intentId },
    }),
  };
}
describe("ordinary Person ActivityPub delivery contract (not Group federation)", () => {
  it.each(["bonfire", "emissary", "lemmy", "piefed", "mbin", "nodebb", "catodon"])(
    "%s: a direct Follow targets exactly the intended Person inbox", software => {
      const p = follow(software);
      expect(parseActivityPubDeliveryPlanV1(p).remoteRecipients).toHaveLength(1);
      const { normalized, identity } = route(p);
      expect(identity).toBe(p.intentId);
      expect(normalized.targets).toHaveLength(1);
      expect(normalized.targets[0]?.deliveryUrl).toBe(target(software).inboxUrl);
      expect(normalized.targets[0]?.sharedInboxUrl).toBeUndefined();
    }
  );

  it("keeps multiple people at the same server distinct for a private Follow", () => {
    const p = follow("mbin");
    const second = {
      actorUri: "https://mbin.example/users/charlie",
      inboxUrl: "https://mbin.example/users/charlie/inbox",
      targetDomain: "mbin.example",
    };
    const activityId = sender + "/activities/follow-batch";
    const remoteRecipients = [target("mbin"), second];
    const intentId = "apdm-v1-" + createHash("sha256")
      .update(canonicalizeDeliveryPlanValue({
        schema: p.schema, actorUri: sender, activityId,
        localRecipientUris: [],
        remoteRecipientUris: remoteRecipients.map(r => r.actorUri).sort(),
      })).digest("hex");
    const fanout = {
      ...p, intentId, activityId,
      activity: { ...p.activity, id: activityId,
        to: remoteRecipients.map(r => r.actorUri) },
      remoteRecipients,
    };
    expect(safeParseActivityPubDeliveryPlanV1(fanout).success).toBe(true);
    const { normalized } = route(fanout);
    expect(normalized.targets.map(x => x.deliveryUrl)).toEqual(
      remoteRecipients.map(x => x.inboxUrl)
    );
  });

  it("rejects forged sender, omitted recipient and unauthorized direct delivery", () => {
    const p = follow("emissary");
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, activity: { ...p.activity, actor: "https://attacker.example/users/alice" }
    }).success).toBe(false);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, remoteRecipients: [],
    }).success).toBe(false);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, meta: { visibility: "public", isPublicActivity: true },
    }).success).toBe(false);
    expect(() => validateApdmWebhookIdentity({
      normalizedTargets: route(p).normalized,
      headerIntentId: "apdm-v1-" + "f".repeat(64),
      meta: { deliveryPlanSchema: p.schema, deliveryPlanIntentId: p.intentId },
    })).toThrow();
  });

  it("keeps Person delivery independent of any Group-specific module", () => {
    const p = follow("catodon");
    expect(p.activity.type).toBe("Follow");
    expect(route(p).normalized.targets).toHaveLength(1);
  });
});
