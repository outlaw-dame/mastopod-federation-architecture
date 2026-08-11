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

  it("rejects non-JSON fingerprint inputs instead of permitting ambiguous canonical forms", () => {
    expect(() => canonicalizeDeliveryPlanValue([undefined])).toThrow(/unsupported undefined/u);
    expect(() => canonicalizeDeliveryPlanValue({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalizeDeliveryPlanValue(new Date())).toThrow(/non-JSON object/u);
  });
});
