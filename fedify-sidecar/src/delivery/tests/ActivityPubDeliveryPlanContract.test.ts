import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256,
  ACTIVITYPUB_DELIVERY_PLAN_JSON_SCHEMA_SHA256,
  ACTIVITYPUB_DELIVERY_PLAN_SCHEMA,
  activityPubDeliveryPlanFingerprint,
  parseActivityPubDeliveryPlanV1,
  safeParseActivityPubDeliveryPlanV1,
} from "../ActivityPubDeliveryPlanContract.js";

const FOLLOWERS_ONLY_FIXTURE_SHA256 = "e166848b9d82e369fa6bace448dbd8ca42949aae9bdbba3b4034f0749d3d087c";

function loadJson(relativePath: string): unknown {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function loadFixture(): unknown {
  return loadJson("./fixtures/ap.delivery-plan.v1.fixture.json");
}

function loadFollowersOnlyFixture(): unknown {
  return loadJson("./fixtures/ap.delivery-plan.v1.followers-only.fixture.json");
}

function loadJsonSchema(): unknown {
  return loadJson("../contracts/ap.delivery-plan.v1.schema.json");
}

describe("APDM delivery plan v1 consumer contract", () => {
  it("parses the shared producer/consumer fixture", () => {
    const plan = parseActivityPubDeliveryPlanV1(loadFixture());
    expect(plan.schema).toBe(ACTIVITYPUB_DELIVERY_PLAN_SCHEMA);
    expect(plan.localRecipients).toHaveLength(1);
    expect(plan.remoteRecipients).toHaveLength(1);
  });

  it("pins the cross-repo fixture fingerprint", () => {
    expect(activityPubDeliveryPlanFingerprint(loadFixture())).toBe(
      ACTIVITYPUB_DELIVERY_PLAN_FIXTURE_SHA256,
    );
  });

  it("pins the cross-repo JSON schema fingerprint", () => {
    expect(activityPubDeliveryPlanFingerprint(loadJsonSchema())).toBe(
      ACTIVITYPUB_DELIVERY_PLAN_JSON_SCHEMA_SHA256,
    );
  });

  it("preserves resolved local dataset/inbox authority", () => {
    const plan = parseActivityPubDeliveryPlanV1(loadFixture());
    expect(plan.localRecipients[0]).toEqual({
      actorUri: "https://pods.example/bob",
      dataset: "bob",
      inboxUri: "https://pods.example/bob/inbox",
    });
  });

  it("preserves remote actor, inbox and sharedInbox information", () => {
    const plan = parseActivityPubDeliveryPlanV1(loadFixture());
    expect(plan.remoteRecipients[0]).toEqual({
      actorUri: "https://remote.example/users/carol",
      inboxUrl: "https://remote.example/users/carol/inbox",
      sharedInboxUrl: "https://remote.example/inbox",
      targetDomain: "remote.example",
    });
  });

  it("fails closed on an unknown contract version", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    expect(
      safeParseActivityPubDeliveryPlanV1({
        ...fixture,
        schema: "ap.delivery-plan.v2",
      }).success,
    ).toBe(false);
  });

  it("rejects an unresolved followers collection without an inbox target", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    expect(
      safeParseActivityPubDeliveryPlanV1({
        ...fixture,
        remoteRecipients: [
          {
            actorUri: "https://pods.example/alice/followers",
            inboxUrl: "",
            targetDomain: "pods.example",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("parses the Phase 3 followers-only fixture with concrete remote followers", () => {
    const raw = loadFollowersOnlyFixture();
    expect(activityPubDeliveryPlanFingerprint(raw)).toBe(FOLLOWERS_ONLY_FIXTURE_SHA256);
    const plan = parseActivityPubDeliveryPlanV1(raw);

    expect(plan.activity.to).toEqual(["https://pods.example/alice/followers"]);
    expect(plan.meta.visibility).toBe("followers");
    expect(plan.meta.isPublicActivity).toBe(false);
    expect(plan.localRecipients).toHaveLength(1);
    expect(plan.remoteRecipients).toHaveLength(2);
    expect(plan.remoteRecipients.map((target) => target.actorUri)).toEqual([
      "https://remote.example/users/carol",
      "https://elsewhere.example/users/dana",
    ]);
    expect(plan.remoteRecipients.some((target) => target.actorUri.endsWith("/followers"))).toBe(false);
    expect(plan.remoteRecipients.every((target) => target.inboxUrl.startsWith("https://"))).toBe(true);
  });
});
