import { describe, expect, it } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import { evaluateActivityPubSubjectPolicy } from "./ActivityPubSubjectPolicy.js";

describe("evaluateActivityPubSubjectPolicy", () => {
  it("rejects matching actor URIs in enforce mode", async () => {
    const now = () => "2026-04-21T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("activitypub-subject-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("activitypub-subject-policy config missing");

    await store.setModuleConfig("activitypub-subject-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        rules: [
          {
            id: "rule-reject-actor",
            action: "reject",
            actorUri: "https://blocked.example/users/spammer",
          },
        ],
      },
    });

    const decision = await evaluateActivityPubSubjectPolicy(store, {
      activityId: "https://blocked.example/activities/1",
      actorUri: "https://blocked.example/users/spammer",
      visibility: "public",
    }, { now, requestId: "req-ap-subject-1" });

    expect(decision?.desiredAction).toBe("reject");
    expect(decision?.appliedAction).toBe("reject");
    expect(decision?.matchedRuleId).toBe("rule-reject-actor");
    expect(decision?.matchedOn).toBe("actor-uri");
  });

  it("filters matching WebIDs in dry-run mode without applying", async () => {
    const now = () => "2026-04-21T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("activitypub-subject-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("activitypub-subject-policy config missing");

    await store.setModuleConfig("activitypub-subject-policy", {
      ...current,
      mode: "dry-run",
      config: {
        ...current.config,
        rules: [
          {
            id: "rule-filter-webid",
            action: "filter",
            webId: "https://pod.example/alice/profile/card",
          },
        ],
      },
    });

    const decision = await evaluateActivityPubSubjectPolicy(store, {
      activityId: "https://remote.example/activities/2",
      actorUri: "https://remote.example/users/alice",
      actorWebId: "https://pod.example/alice/profile/card",
      visibility: "followers",
    }, { now, requestId: "req-ap-subject-2" });

    expect(decision?.desiredAction).toBe("filter");
    expect(decision?.appliedAction).toBe("accept");
    expect(decision?.matchedRuleId).toBe("rule-filter-webid");
    expect(decision?.matchedOn).toBe("webid");
  });

  it("prefers reject over filter when a stronger domain rule exists", async () => {
    const now = () => "2026-04-21T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const current = await store.getModuleConfig("activitypub-subject-policy");
    expect(current).not.toBeNull();
    if (!current) throw new Error("activitypub-subject-policy config missing");

    await store.setModuleConfig("activitypub-subject-policy", {
      ...current,
      mode: "enforce",
      config: {
        ...current.config,
        rules: [
          {
            id: "rule-filter-actor",
            action: "filter",
            actorUri: "https://remote.example/users/alice",
          },
          {
            id: "rule-reject-domain",
            action: "reject",
            domain: "remote.example",
          },
        ],
      },
    });

    const decision = await evaluateActivityPubSubjectPolicy(store, {
      activityId: "https://remote.example/activities/3",
      actorUri: "https://remote.example/users/alice",
    }, { now, requestId: "req-ap-subject-3" });

    expect(decision?.desiredAction).toBe("reject");
    expect(decision?.matchedRuleId).toBe("rule-reject-domain");
    expect(decision?.matchedOn).toBe("domain");
    expect(decision?.matchedValue).toBe("remote.example");
  });

  it("returns null when no subject rule matches", async () => {
    const now = () => "2026-04-21T12:00:00.000Z";
    const store = new InMemoryMRFAdminStore(now);
    await ensureDefaultModuleConfigs(store, now);

    const decision = await evaluateActivityPubSubjectPolicy(store, {
      activityId: "https://remote.example/activities/4",
      actorUri: "https://remote.example/users/alice",
    }, { now, requestId: "req-ap-subject-4" });

    expect(decision).toBeNull();
  });
});
