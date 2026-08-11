import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalizeDeliveryPlanValue,
  safeParseActivityPubDeliveryPlanV1,
} from "../ActivityPubDeliveryPlanContract.js";

function loadFixture(): Record<string, any> {
  const url = new URL("./fixtures/ap.delivery-plan.v1.fixture.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, any>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recomputeIntentId(plan: Record<string, any>): string {
  const material = canonicalizeDeliveryPlanValue({
    schema: "ap.delivery-plan.v1",
    activityId: plan.activityId,
    actorUri: plan.actorUri,
    localRecipientUris: [...new Set(plan.localRecipients.map((target: any) => target.actorUri))].sort(),
    remoteRecipientUris: [...new Set(plan.remoteRecipients.map((target: any) => target.actorUri))].sort(),
  });
  return `apdm-v1-${createHash("sha256").update(material).digest("hex")}`;
}

describe("APDM Phase 1 consumer hardening", () => {
  it("rejects searchConsent arrays so the consumer matches the producer and JSON Schema", () => {
    const plan = clone(loadFixture());
    plan.meta.searchConsent = [];
    expect(safeParseActivityPubDeliveryPlanV1(plan).success).toBe(false);
  });

  it("rejects fragments and normalization whitespace in executable delivery URLs", () => {
    const fragmented = clone(loadFixture());
    fragmented.remoteRecipients[0].sharedInboxUrl = "https://remote.example/inbox#fragment";
    expect(safeParseActivityPubDeliveryPlanV1(fragmented).success).toBe(false);

    const padded = clone(loadFixture());
    padded.remoteRecipients[0].sharedInboxUrl = " https://remote.example/inbox";
    expect(safeParseActivityPubDeliveryPlanV1(padded).success).toBe(false);
  });

  it("rejects ambiguous local dataset authority strings", () => {
    const padded = clone(loadFixture());
    padded.localRecipients[0].dataset = " bob ";
    expect(safeParseActivityPubDeliveryPlanV1(padded).success).toBe(false);

    const controlled = clone(loadFixture());
    controlled.localRecipients[0].dataset = "bob\nadmin";
    expect(safeParseActivityPubDeliveryPlanV1(controlled).success).toBe(false);
  });

  it("canonicalizes domain authority by rejecting trailing-dot targetDomain aliases", () => {
    const aliased = clone(loadFixture());
    aliased.remoteRecipients[0].sharedInboxUrl = "https://remote.example./inbox";
    aliased.remoteRecipients[0].targetDomain = "remote.example.";
    expect(safeParseActivityPubDeliveryPlanV1(aliased).success).toBe(false);

    const canonical = clone(loadFixture());
    canonical.remoteRecipients[0].sharedInboxUrl = "https://remote.example./inbox";
    canonical.remoteRecipients[0].targetDomain = "remote.example";
    expect(safeParseActivityPubDeliveryPlanV1(canonical).success).toBe(true);
  });

  it("does not misclassify an unrelated actor whose path happens to end in /followers", () => {
    const recipientUri = "https://remote.example/users/followers";
    const plan = clone(loadFixture());
    plan.activity.to = [recipientUri];
    plan.activity.cc = [];
    plan.meta = { visibility: "direct", isPublicActivity: false };
    plan.remoteRecipients = [{
      actorUri: recipientUri,
      inboxUrl: `${recipientUri}/inbox`,
      targetDomain: "remote.example",
    }];
    plan.intentId = recomputeIntentId(plan);
    expect(safeParseActivityPubDeliveryPlanV1(plan).success).toBe(true);

    plan.meta = { visibility: "followers", isPublicActivity: false };
    expect(safeParseActivityPubDeliveryPlanV1(plan).success).toBe(false);
  });

  it("rejects a plan that omits any explicitly addressed concrete actor", () => {
    const omitted = clone(loadFixture());
    omitted.activity.bcc = ["https://remote.example/users/missing"];
    expect(safeParseActivityPubDeliveryPlanV1(omitted).success).toBe(false);

    const included = clone(loadFixture());
    included.activity.bcc = ["https://remote.example/users/carol"];
    expect(safeParseActivityPubDeliveryPlanV1(included).success).toBe(true);
  });

  it("rejects non-JSON fingerprint inputs instead of permitting ambiguous canonical forms", () => {
    expect(() => canonicalizeDeliveryPlanValue([undefined])).toThrow(/unsupported undefined/u);
    expect(() => canonicalizeDeliveryPlanValue({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalizeDeliveryPlanValue(new Date())).toThrow(/non-JSON object/u);
  });
});
