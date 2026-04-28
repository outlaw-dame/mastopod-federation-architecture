import { describe, expect, it } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import type { ActorReputationConfig } from "../admin/mrf/registry/modules/actor-reputation.js";
import { evaluateActorReputation } from "./ActorReputationPolicy.js";

const NOW = () => "2026-04-27T12:00:00.000Z";

async function makeStore(
  overrides: Partial<ActorReputationConfig> = {},
  mode: "dry-run" | "enforce" = "enforce",
) {
  const mrf = new InMemoryMRFAdminStore(NOW);
  await ensureDefaultModuleConfigs(mrf, NOW);
  const current = await mrf.getModuleConfig("actor-reputation");
  if (!current) throw new Error("actor-reputation module missing from registry");
  await mrf.setModuleConfig("actor-reputation", {
    ...current,
    enabled: true,
    mode,
    config: { ...current.config, ...overrides },
  });
  return mrf;
}

const CLEAN_ACTOR: Record<string, unknown> = {
  published: "2020-01-01T00:00:00Z",
  followers: { totalItems: 500 },
  icon: { url: "https://example.com/avatar.png" },
  summary: "<p>A real person.</p>",
};

const CLEAN_ACTIVITY: Record<string, unknown> = {
  object: { content: "<p>A normal post.</p>" },
};

describe("evaluateActorReputation", () => {
  it("returns null when store is null", async () => {
    const result = await evaluateActorReputation(null, {
      activityId: "https://remote.example/activities/1",
      actorUri: "https://remote.example/users/alice",
      actorDocument: CLEAN_ACTOR,
      activity: CLEAN_ACTIVITY,
    });
    expect(result).toBeNull();
  });

  it("returns null when module is disabled", async () => {
    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);
    const current = await mrf.getModuleConfig("actor-reputation");
    if (!current) throw new Error("missing");
    await mrf.setModuleConfig("actor-reputation", { ...current, enabled: false });

    const result = await evaluateActorReputation(mrf, {
      activityId: "https://remote.example/activities/2",
      actorUri: "https://remote.example/users/alice",
      actorDocument: null,
      activity: CLEAN_ACTIVITY,
    });
    expect(result).toBeNull();
  });

  it("returns null when no signals fire (healthy actor)", async () => {
    const mrf = await makeStore({ minSignalsToFlag: 1 });
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/3",
        actorUri: "https://remote.example/users/alice",
        actorDocument: CLEAN_ACTOR,
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).toBeNull();
  });

  it("fires new-account signal for a young account", async () => {
    // Account created 1 day ago; threshold is 7 days
    const mrf = await makeStore({ maxAccountAgeDays: 7, minSignalsToFlag: 1 });
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/4",
        actorUri: "https://remote.example/users/newbie",
        actorDocument: {
          ...CLEAN_ACTOR,
          published: "2026-04-26T12:00:00Z", // 1 day before NOW
        },
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("new-account");
  });

  it("fires low-followers signal when follower count is below threshold", async () => {
    const mrf = await makeStore({ minFollowerCount: 10, minSignalsToFlag: 1 });
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/5",
        actorUri: "https://remote.example/users/newbie",
        actorDocument: { ...CLEAN_ACTOR, followers: { totalItems: 2 } },
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("low-followers");
  });

  it("fires link-density signal when content has too many links", async () => {
    const mrf = await makeStore({ maxLinksInContent: 2, minSignalsToFlag: 1 });
    const links = Array.from({ length: 5 }, (_, i) => `<a href="https://example${i}.com">x</a>`).join(" ");
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/6",
        actorUri: "https://remote.example/users/spammer",
        actorDocument: CLEAN_ACTOR,
        activity: { object: { content: `<p>${links}</p>` } },
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("link-density");
  });

  it("fires hashtag-flood signal when hashtag count exceeds threshold", async () => {
    const mrf = await makeStore({ maxHashtagCount: 3, minSignalsToFlag: 1 });
    const tags = Array.from({ length: 6 }, (_, i) => ({ type: "Hashtag", name: `#tag${i}` }));
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/7",
        actorUri: "https://remote.example/users/spammer",
        actorDocument: CLEAN_ACTOR,
        activity: { object: { content: "<p>tags</p>", tag: tags } },
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("hashtag-flood");
  });

  it("fires mention-storm signal when cc mention count exceeds threshold", async () => {
    const mrf = await makeStore({ maxMentionCount: 5, minSignalsToFlag: 1 });
    const cc = Array.from({ length: 8 }, (_, i) => `https://remote.example/users/user${i}`);
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/8",
        actorUri: "https://remote.example/users/spammer",
        actorDocument: CLEAN_ACTOR,
        activity: { cc, object: { content: "<p>hi all</p>" } },
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("mention-storm");
  });

  it("fires no-avatar signal when actor has no icon", async () => {
    const mrf = await makeStore({ requireAvatar: true, minSignalsToFlag: 1 });
    const { icon: _icon, ...actorWithoutAvatar } = CLEAN_ACTOR;
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/9",
        actorUri: "https://remote.example/users/alice",
        actorDocument: actorWithoutAvatar,
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("no-avatar");
  });

  it("fires no-bio signal when actor has no summary", async () => {
    const mrf = await makeStore({ requireBio: true, minSignalsToFlag: 1 });
    const { summary: _summary, ...actorWithoutBio } = CLEAN_ACTOR;
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/10",
        actorUri: "https://remote.example/users/alice",
        actorDocument: actorWithoutBio,
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.signals).toContain("no-bio");
  });

  it("respects minSignalsToFlag threshold — does not flag if below", async () => {
    // new-account fires (1 signal) but threshold is 2
    const mrf = await makeStore({ maxAccountAgeDays: 7, minSignalsToFlag: 2 });
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/11",
        actorUri: "https://remote.example/users/newbie",
        actorDocument: { ...CLEAN_ACTOR, published: "2026-04-26T12:00:00Z" },
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).toBeNull();
  });

  it("applies desiredAction in enforce mode", async () => {
    const mrf = await makeStore({ maxAccountAgeDays: 7, minSignalsToFlag: 1, action: "filter" }, "enforce");
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/12",
        actorUri: "https://remote.example/users/newbie",
        actorDocument: { ...CLEAN_ACTOR, published: "2026-04-26T12:00:00Z" },
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.appliedAction).toBe("filter");
  });

  it("applies accept in dry-run mode regardless of desiredAction", async () => {
    const mrf = await makeStore({ maxAccountAgeDays: 7, minSignalsToFlag: 1, action: "reject" }, "dry-run");
    const result = await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/13",
        actorUri: "https://remote.example/users/newbie",
        actorDocument: { ...CLEAN_ACTOR, published: "2026-04-26T12:00:00Z" },
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.desiredAction).toBe("reject");
    expect(result!.appliedAction).toBe("accept");
  });

  it("writes a trace entry on a match", async () => {
    const mrf = await makeStore({ maxAccountAgeDays: 7, minSignalsToFlag: 1 });
    await evaluateActorReputation(
      mrf,
      {
        activityId: "https://remote.example/activities/14",
        actorUri: "https://remote.example/users/newbie",
        actorDocument: { ...CLEAN_ACTOR, published: "2026-04-26T12:00:00Z" },
        activity: CLEAN_ACTIVITY,
      },
      { now: NOW, requestId: "req-ar-trace" },
    );

    const traces = await mrf.listTraces({ limit: 10 });
    const trace = traces.items.find((t) => t.moduleId === "actor-reputation");
    expect(trace).toBeDefined();
    expect(trace!.activityId).toBe("https://remote.example/activities/14");
  });
});
