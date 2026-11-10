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
 * Group federation contract tests use fake HTTPS origins. These exercise
 * the real APDM plan parser and Fedify-sidecar outbound target normalizer,
 * NOT HTTP delivery or membership authorization. ActivityPods must verify
 * group membership and construct the concrete authorized recipient set.
 */
const group = "https://pods.example/groups/cg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const activityId = group + "/activities/post-1";
const local = (id: number) => ({
  actorUri: "https://pods.example/users/local-" + id,
  dataset: "local-" + id,
  inboxUri: "https://pods.example/users/local-" + id + "/inbox",
});
const remote = (server: number, id: number, shared: boolean) => {
  const host = "instance-" + server + ".example";
  return {
    actorUri: "https://" + host + "/users/member-" + id,
    inboxUrl: "https://" + host + "/users/member-" + id + "/inbox",
    ...(shared ? { sharedInboxUrl: "https://" + host + "/inbox" } : {}),
    targetDomain: host,
  };
};
function plan(localRecipients: ReturnType<typeof local>[], remoteRecipients: ReturnType<typeof remote>[]) {
  const material = {
    schema: "ap.delivery-plan.v1",
    activityId,
    actorUri: group,
    localRecipientUris: localRecipients.map(r => r.actorUri).sort(),
    remoteRecipientUris: remoteRecipients.map(r => r.actorUri).sort(),
  };
  const intentId = "apdm-v1-" + createHash("sha256")
    .update(canonicalizeDeliveryPlanValue(material)).digest("hex");
  return {
    schema: "ap.delivery-plan.v1",
    intentId,
    activityId,
    actorUri: group,
    activity: {
      id: activityId,
      actor: group,
      type: "Create",
      to: [group + "/followers"],
      object: { id: activityId + "/object", type: "Note", content: "Public group post" },
    },
    localRecipients,
    remoteRecipients,
    meta: { visibility: "followers", isPublicActivity: false },
  };
}
function sidecar(planValue: ReturnType<typeof plan>) {
  return normalizeAndDedupeOutboundTargets(
    planValue.remoteRecipients.map(({ actorUri: _actorUri, ...target }) => ({
      ...target,
      apdmAuthority: { schema: "ap.delivery-plan.v1", intentId: planValue.intentId },
    })),
    {
      maxTargetsPerRequest: Math.max(planValue.remoteRecipients.length, 1),
      maxPending: 100_000, maxQueueDepth: 0, retryAfterSeconds: 5,
    },
  );
}
describe("Paper Groups cross-instance Fedify/APDM boundary", () => {
  it("preserves mixed local/remote identity and deduplicates only authoritative shared inboxes", () => {
    const p = plan(
      [local(0), local(1)],
      [remote(1, 0, true), remote(1, 1, true), remote(2, 2, false), remote(2, 3, false), remote(3, 4, true)],
    );
    expect(parseActivityPubDeliveryPlanV1(p).remoteRecipients).toHaveLength(5);
    const result = sidecar(p);
    expect(result.targets).toHaveLength(4);
    expect(result.duplicateTargetCount).toBe(1);
    expect(result.invalidTargetCount).toBe(0);
    expect(result.targets.map(t => t.deliveryUrl)).toEqual([
      "https://instance-1.example/inbox",
      "https://instance-2.example/users/member-2/inbox",
      "https://instance-2.example/users/member-3/inbox",
      "https://instance-3.example/inbox",
    ]);
    expect(result.targets.every(t => !t.deliveryUrl.startsWith("https://pods.example/"))).toBe(true);
    expect(validateApdmWebhookIdentity({
      normalizedTargets: result,
      headerIntentId: p.intentId,
      meta: { deliveryPlanSchema: p.schema, deliveryPlanIntentId: p.intentId },
    })).toBe(p.intentId);
  });

  it("accepts 1,000 remote actor targets on 10 instance domains without per-actor discovery", () => {
    const recipients = Array.from({ length: 1000 }, (_, i) => remote(i % 10, i, true));
    const p = plan([local(0)], recipients);
    expect(safeParseActivityPubDeliveryPlanV1(p).success).toBe(true);
    const result = sidecar(p);
    expect(result.inputTargetCount).toBe(1000);
    expect(result.targets).toHaveLength(10);
    expect(result.duplicateTargetCount).toBe(990);
    expect(result.invalidTargetCount).toBe(0);
    expect(new Set(result.targets.map(t => t.deliveryUrl)).size).toBe(10);
    // No limit on member cardinality is implied: the producer/queue must
    // still enforce its own batching/backpressure and authorized snapshot.
  });

  it("does not collapse 1,000 personal inboxes just because actors share one host", () => {
    const p = plan([], Array.from({ length: 1000 }, (_, i) => remote(1, i, false)));
    expect(safeParseActivityPubDeliveryPlanV1(p).success).toBe(true);
    const result = sidecar(p);
    expect(result.targets).toHaveLength(1000);
    expect(result.duplicateTargetCount).toBe(0);
  });

  it("rejects unsupported, missing and forged remote authority rather than guessing membership", () => {
    const p = plan([], [remote(1, 0, true)]);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, intentId: "apdm-v1-" + "f".repeat(64),
    }).success).toBe(false);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, remoteRecipients: [local(1)],
    }).success).toBe(false);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, activity: { ...p.activity, bcc: ["https://instance-2.example/users/private"] },
    }).success).toBe(false);
    expect(() => validateApdmWebhookIdentity({
      normalizedTargets: sidecar(p),
      headerIntentId: "apdm-v1-" + "b".repeat(64),
      meta: { deliveryPlanSchema: p.schema, deliveryPlanIntentId: p.intentId },
    })).toThrow();
  });

  it("never maps a remote actor into a local Pod or trusts a changed signed payload", () => {
    const r = remote(1, 0, false);
    const p = plan([local(0)], [r]);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p,
      localRecipients: [...p.localRecipients, { ...local(1), actorUri: r.actorUri }],
    }).success).toBe(false);
    expect(safeParseActivityPubDeliveryPlanV1({
      ...p, activity: { ...p.activity, actor: "https://attacker.example/groups/other" },
    }).success).toBe(false);
  });
});
