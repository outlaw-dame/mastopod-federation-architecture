import { describe, expect, it } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import type { ContentFingerprintConfig } from "../admin/mrf/registry/modules/content-fingerprint.js";
import { InMemoryContentFingerprintStore } from "../delivery/ContentFingerprintGuard.js";
import { evaluateContentFingerprint } from "./ContentFingerprintPolicy.js";

const NOW = () => "2026-04-27T12:00:00.000Z";

async function makeStore(
  overrides: Partial<ContentFingerprintConfig> = {},
  mode: "dry-run" | "enforce" = "enforce",
) {
  const mrf = new InMemoryMRFAdminStore(NOW);
  await ensureDefaultModuleConfigs(mrf, NOW);
  const current = await mrf.getModuleConfig("content-fingerprint");
  if (!current) throw new Error("content-fingerprint module missing from registry");
  await mrf.setModuleConfig("content-fingerprint", {
    ...current,
    enabled: true,
    mode,
    config: { ...current.config, ...overrides },
  });
  return mrf;
}

const SPAM_CONTENT = "<p>Buy now at https://spam.example/buy — limited offer!</p>";

function makeActivity(content: string): Record<string, unknown> {
  return { object: { content } };
}

describe("evaluateContentFingerprint", () => {
  it("returns null when mrfStore is null", async () => {
    const cfp = new InMemoryContentFingerprintStore();
    const result = await evaluateContentFingerprint(null, cfp, {
      activityId: "https://remote.example/activities/1",
      actorUri: "https://remote.example/users/alice",
      activity: makeActivity(SPAM_CONTENT),
    });
    expect(result).toBeNull();
  });

  it("returns null when fingerprintStore is null", async () => {
    const mrf = await makeStore();
    const result = await evaluateContentFingerprint(mrf, null, {
      activityId: "https://remote.example/activities/2",
      actorUri: "https://remote.example/users/alice",
      activity: makeActivity(SPAM_CONTENT),
    });
    expect(result).toBeNull();
  });

  it("returns null when module is disabled", async () => {
    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);
    const current = await mrf.getModuleConfig("content-fingerprint");
    if (!current) throw new Error("missing");
    await mrf.setModuleConfig("content-fingerprint", { ...current, enabled: false });

    const cfp = new InMemoryContentFingerprintStore();
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/3",
      actorUri: "https://remote.example/users/alice",
      activity: makeActivity(SPAM_CONTENT),
    });
    expect(result).toBeNull();
  });

  it("returns null when activity carries no content body", async () => {
    const mrf = await makeStore({ maxDistinctActors: 2 });
    const cfp = new InMemoryContentFingerprintStore();
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/4",
      actorUri: "https://remote.example/users/alice",
      activity: { type: "Like", object: "https://remote.example/notes/1" },
    });
    expect(result).toBeNull();
  });

  it("returns null when content is below minContentLength", async () => {
    const mrf = await makeStore({ minContentLength: 200, maxDistinctActors: 2 });
    const cfp = new InMemoryContentFingerprintStore();
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/5",
      actorUri: "https://remote.example/users/alice",
      activity: makeActivity("<p>Hi</p>"),
    });
    expect(result).toBeNull();
  });

  it("returns null when distinct actor count is at or below threshold", async () => {
    // maxDistinctActors: 3 — threshold is 3; sending from exactly 3 actors must NOT trigger
    const mrf = await makeStore({ maxDistinctActors: 3, minContentLength: 0 });
    const cfp = new InMemoryContentFingerprintStore();

    for (let i = 1; i <= 3; i++) {
      await evaluateContentFingerprint(mrf, cfp, {
        activityId: `https://remote.example/activities/6-${i}`,
        actorUri: `https://remote.example/users/actor${i}`,
        activity: makeActivity(SPAM_CONTENT),
      }, { now: NOW });
    }

    // Same actor again — count stays at 3, still at threshold (not over)
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/6-check",
      actorUri: "https://remote.example/users/actor3",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW });

    expect(result).toBeNull();
  });

  it("triggers when distinct actors exceed the threshold in enforce mode", async () => {
    // maxDistinctActors: 2 — 3 distinct actors exceeds the threshold
    const mrf = await makeStore({ maxDistinctActors: 2, minContentLength: 0 }, "enforce");
    const cfp = new InMemoryContentFingerprintStore();

    // First 2 actors — at threshold, no trigger
    for (let i = 1; i <= 2; i++) {
      await evaluateContentFingerprint(mrf, cfp, {
        activityId: `https://remote.example/activities/7-${i}`,
        actorUri: `https://remote.example/users/actor${i}`,
        activity: makeActivity(SPAM_CONTENT),
      }, { now: NOW });
    }

    // 3rd actor pushes count to 3, which exceeds maxDistinctActors=2
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/7-3",
      actorUri: "https://remote.example/users/actor3",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW, requestId: "req-cfp-test-1" });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("content-fingerprint");
    expect(result!.distinctActorCount).toBe(3);
    expect(result!.appliedAction).not.toBe("accept");
  });

  it("applies accept in dry-run mode even when threshold exceeded", async () => {
    // maxDistinctActors: 2 — 3 actors exceeds; but dry-run applies accept
    const mrf = await makeStore({ maxDistinctActors: 2, minContentLength: 0 }, "dry-run");
    const cfp = new InMemoryContentFingerprintStore();

    for (let i = 1; i <= 3; i++) {
      await evaluateContentFingerprint(mrf, cfp, {
        activityId: `https://remote.example/activities/8-${i}`,
        actorUri: `https://remote.example/users/actor${i}`,
        activity: makeActivity(SPAM_CONTENT),
      }, { now: NOW });
    }

    // 4th actor triggers (count=4 > 2) in dry-run
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/8-4",
      actorUri: "https://remote.example/users/actor4",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW });

    expect(result).not.toBeNull();
    expect(result!.appliedAction).toBe("accept");
    expect(["filter", "reject", "label"]).toContain(result!.desiredAction);
  });

  it("does not inflate count for repeated sends from the same actor", async () => {
    // maxDistinctActors: 2 — alice sends 5 times (counts as 1), bob sends (count=2, no trigger),
    // carol sends (count=3 > 2, triggers). Verify count is 3, not 7 (5+1+1).
    const mrf = await makeStore({ maxDistinctActors: 2, minContentLength: 0 }, "enforce");
    const cfp = new InMemoryContentFingerprintStore();

    // Alice sends 5 times — must count as only 1 distinct actor
    for (let i = 0; i < 5; i++) {
      await evaluateContentFingerprint(mrf, cfp, {
        activityId: "https://remote.example/activities/9-alice",
        actorUri: "https://remote.example/users/alice",
        activity: makeActivity(SPAM_CONTENT),
      }, { now: NOW });
    }

    // Bob sends — count becomes 2 (at threshold, no trigger)
    await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/9-bob",
      actorUri: "https://remote.example/users/bob",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW });

    // Carol sends — count becomes 3, exceeds threshold, triggers
    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/9-carol",
      actorUri: "https://remote.example/users/carol",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW });

    expect(result).not.toBeNull();
    // distinctActorCount must be 3 (alice+bob+carol), not inflated by alice's 5 sends
    expect(result!.distinctActorCount).toBe(3);
  });

  it("includes a content hash in the result", async () => {
    // Use maxDistinctActors: 2 and 3 actors to trigger
    const mrf = await makeStore({ maxDistinctActors: 2, minContentLength: 0 }, "enforce");
    const cfp = new InMemoryContentFingerprintStore();

    for (let i = 1; i <= 2; i++) {
      await evaluateContentFingerprint(mrf, cfp, {
        activityId: `https://remote.example/activities/10-${i}`,
        actorUri: `https://remote.example/users/actor${i}`,
        activity: makeActivity(SPAM_CONTENT),
      }, { now: NOW });
    }

    const result = await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/10",
      actorUri: "https://remote.example/users/alice",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW });

    expect(result).not.toBeNull();
    expect(typeof result!.contentHash).toBe("string");
    expect(result!.contentHash).toHaveLength(64); // SHA-256 hex
  });

  it("writes a trace entry on a match", async () => {
    // maxDistinctActors: 2 — prime with 2 actors, then a 3rd triggers the trace
    const mrf = await makeStore({ maxDistinctActors: 2, minContentLength: 0 }, "enforce");
    const cfp = new InMemoryContentFingerprintStore();

    for (let i = 1; i <= 2; i++) {
      await evaluateContentFingerprint(mrf, cfp, {
        activityId: `https://remote.example/activities/11-prime-${i}`,
        actorUri: `https://remote.example/users/actor${i}`,
        activity: makeActivity(SPAM_CONTENT),
      }, { now: NOW });
    }

    await evaluateContentFingerprint(mrf, cfp, {
      activityId: "https://remote.example/activities/11",
      actorUri: "https://remote.example/users/alice",
      activity: makeActivity(SPAM_CONTENT),
    }, { now: NOW, requestId: "req-cfp-trace" });

    const traces = await mrf.listTraces({ limit: 10 });
    const trace = traces.items.find((t) => t.moduleId === "content-fingerprint");
    expect(trace).toBeDefined();
    expect(trace!.activityId).toBe("https://remote.example/activities/11");
  });
});
