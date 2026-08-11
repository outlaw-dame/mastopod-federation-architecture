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
  const localRecipients = plan["localRecipients"] as Array<Record<string, any>>;
  const remoteRecipients = plan["remoteRecipients"] as Array<Record<string, any>>;
  const material = canonicalizeDeliveryPlanValue({
    schema: "ap.delivery-plan.v1",
    activityId: plan["activityId"],
    actorUri: plan["actorUri"],
    localRecipientUris: [...new Set(localRecipients.map((target) => target["actorUri"] as string))].sort(),
    remoteRecipientUris: [...new Set(remoteRecipients.map((target) => target["actorUri"] as string))].sort(),
  });
  return `apdm-v1-${createHash("sha256").update(material).digest("hex")}`;
}

describe("APDM Phase 1 consumer hardening", () => {
  it("rejects searchConsent arrays so the consumer matches the producer and JSON Schema", () => {
    const plan = clone(loadFixture());
    (plan["meta"] as Record<string, unknown>)["searchConsent"] = [];
    expect(safeParseActivityPubDeliveryPlanV1(plan).success).toBe(false);
  });

  it("rejects fragments and normalization whitespace in executable delivery URLs", () => {
    const fragmented = clone(loadFixture());
    ((fragmented["remoteRecipients"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["sharedInboxUrl"] =
      "https://remote.example/inbox#fragment";
    expect(safeParseActivityPubDeliveryPlanV1(fragmented).success).toBe(false);

    const padded = clone(loadFixture());
    ((padded["remoteRecipients"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["sharedInboxUrl"] =
      " https://remote.example/inbox";
    expect(safeParseActivityPubDeliveryPlanV1(padded).success).toBe(false);
  });

  it("rejects ambiguous local dataset authority strings", () => {
    const padded = clone(loadFixture());
    ((padded["localRecipients"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["dataset"] = " bob ";
    expect(safeParseActivityPubDeliveryPlanV1(padded).success).toBe(false);

    const controlled = clone(loadFixture());
    ((controlled["localRecipients"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)["dataset"] =
      "bob\nadmin";
    expect(safeParseActivityPubDeliveryPlanV1(controlled).success).toBe(false);
  });

  it("canonicalizes domain authority by rejecting trailing-dot targetDomain aliases", () => {
    const aliased = clone(loadFixture());
    const aliasedTarget = (aliased["remoteRecipients"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    aliasedTarget["sharedInboxUrl"] = "https://remote.example./inbox";
    aliasedTarget["targetDomain"] = "remote.example.";
    expect(safeParseActivityPubDeliveryPlanV1(aliased).success).toBe(false);

    const canonical = clone(loadFixture());
    const canonicalTarget = (canonical["remoteRecipients"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    canonicalTarget["sharedInboxUrl"] = "https://remote.example./inbox";
    canonicalTarget["targetDomain"] = "remote.example";
    expect(safeParseActivityPubDeliveryPlanV1(canonical).success).toBe(true);
  });

  it("does not misclassify an unrelated actor whose path happens to end in /followers", () => {
    const recipientUri = "https://remote.example/users/followers";
    const plan = clone(loadFixture());
    const activity = plan["activity"] as Record<string, unknown>;
    activity["to"] = [recipientUri];
    activity["cc"] = [];
    plan["meta"] = { visibility: "direct", isPublicActivity: false };
    plan["remoteRecipients"] = [{
      actorUri: recipientUri,
      inboxUrl: `${recipientUri}/inbox`,
      targetDomain: "remote.example",
    }];
    plan["intentId"] = recomputeIntentId(plan);
    expect(safeParseActivityPubDeliveryPlanV1(plan).success).toBe(true);

    plan["meta"] = { visibility: "followers", isPublicActivity: false };
    expect(safeParseActivityPubDeliveryPlanV1(plan).success).toBe(false);
  });

  it("rejects a plan that omits any explicitly addressed concrete actor", () => {
    const omitted = clone(loadFixture());
    (omitted["activity"] as Record<string, unknown>)["bcc"] = ["https://remote.example/users/missing"];
    expect(safeParseActivityPubDeliveryPlanV1(omitted).success).toBe(false);

    const included = clone(loadFixture());
    (included["activity"] as Record<string, unknown>)["bcc"] = ["https://remote.example/users/carol"];
    expect(safeParseActivityPubDeliveryPlanV1(included).success).toBe(true);
  });

  it("rejects non-JSON fingerprint inputs instead of permitting ambiguous canonical forms", () => {
    expect(() => canonicalizeDeliveryPlanValue([undefined])).toThrow(/unsupported undefined/u);
    expect(() => canonicalizeDeliveryPlanValue({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalizeDeliveryPlanValue(new Date())).toThrow(/non-JSON object/u);
  });
});
