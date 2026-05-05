import { describe, expect, it } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import { InMemoryContentFingerprintStore } from "../delivery/ContentFingerprintGuard.js";
import { InMemoryDomainReputationStore } from "../delivery/DomainReputationStore.js";
import { buildEnvelopeFromAT } from "./MRFActivityEnvelope.js";
import { SpamEvaluator } from "./SpamEvaluator.js";

const NOW = () => "2026-04-27T12:00:00.000Z";

async function makeFullMrf() {
  const mrf = new InMemoryMRFAdminStore(NOW);
  await ensureDefaultModuleConfigs(mrf, NOW);

  // Enable actor-reputation in enforce mode with a low threshold
  const arConfig = await mrf.getModuleConfig("actor-reputation");
  if (!arConfig) throw new Error("actor-reputation missing");
  await mrf.setModuleConfig("actor-reputation", {
    ...arConfig,
    enabled: true,
    mode: "enforce",
    config: { ...arConfig.config, maxAccountAgeDays: 7, minSignalsToFlag: 1, action: "filter" },
  });

  // Enable content-fingerprint in enforce mode; minimum allowed maxDistinctActors is 2
  const cfpConfig = await mrf.getModuleConfig("content-fingerprint");
  if (!cfpConfig) throw new Error("content-fingerprint missing");
  await mrf.setModuleConfig("content-fingerprint", {
    ...cfpConfig,
    enabled: true,
    mode: "enforce",
    config: { ...cfpConfig.config, maxDistinctActors: 2, minContentLength: 0, action: "filter" },
  });

  // Enable domain-reputation in enforce mode
  const drConfig = await mrf.getModuleConfig("domain-reputation");
  if (!drConfig) throw new Error("domain-reputation missing");
  await mrf.setModuleConfig("domain-reputation", {
    ...drConfig,
    enabled: true,
    mode: "enforce",
    config: { ...drConfig.config, action: "filter" },
  });

  return mrf;
}

const OLD_ACTOR: Record<string, unknown> = {
  published: "2020-01-01T00:00:00Z",
  followers: { totalItems: 500 },
  icon: { url: "https://example.com/avatar.png" },
  summary: "<p>Long-standing member.</p>",
};

const NEW_ACTOR: Record<string, unknown> = {
  // 1 day old — below the 7-day threshold
  published: "2026-04-26T12:00:00Z",
  followers: { totalItems: 500 },
  icon: { url: "https://example.com/avatar.png" },
  summary: "<p>New account.</p>",
};

const SAFE_ACTIVITY: Record<string, unknown> = {
  object: { content: "<p>A perfectly normal post.</p>" },
};

const SPAM_ACTIVITY: Record<string, unknown> = {
  object: { content: '<p>Buy now at <a href="https://spam.example/buy">here</a>!</p>' },
};

// ---------------------------------------------------------------------------
// AP path
// ---------------------------------------------------------------------------

describe("SpamEvaluator.evaluateAp", () => {
  it("returns null when all modules are disabled (null store)", async () => {
    const evaluator = new SpamEvaluator(() => null, null, null);
    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/1",
      actorUri: "https://remote.example/users/alice",
      actorDocument: NEW_ACTOR,
      activity: SPAM_ACTIVITY,
    });
    expect(result).toBeNull();
  });

  it("blocks on actor-reputation (new account) before checking fingerprint or domain", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/2",
      actorUri: "https://remote.example/users/newbie",
      actorDocument: NEW_ACTOR,
      activity: SAFE_ACTIVITY,
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("actor-reputation");
    expect(["filter", "reject"]).toContain(result!.appliedAction);
  });

  it("skips to content-fingerprint when actor-reputation passes", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const sameContent = "<p>This is identical spam content sent by multiple actors.</p>";

    // Prime with 2 old trusted actors (at maxDistinctActors=2 threshold — no trigger yet)
    for (let i = 1; i <= 2; i++) {
      await evaluator.evaluateAp({
        activityId: `https://remote.example/activities/3-${i}`,
        actorUri: `https://remote.example/users/actor${i}`,
        actorDocument: OLD_ACTOR,
        activity: { object: { content: sameContent } },
        now: NOW,
      });
    }

    // 3rd old trusted actor pushes count to 3 (exceeds maxDistinctActors=2)
    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/3-final",
      actorUri: "https://remote.example/users/actor3",
      actorDocument: OLD_ACTOR,
      activity: { object: { content: sameContent } },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("content-fingerprint");
  });

  it("reaches domain-reputation when actor-reputation and fingerprint both pass", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("spam.example", false);
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/4",
      actorUri: "https://remote.example/users/alice",
      actorDocument: OLD_ACTOR,
      activity: SPAM_ACTIVITY,
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("domain-reputation");
  });

  it("returns null when the activity is clean and all modules pass", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/5",
      actorUri: "https://remote.example/users/alice",
      actorDocument: OLD_ACTOR,
      activity: SAFE_ACTIVITY,
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it("is fail-open: returns null when getMrfAdminStore throws", async () => {
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(
      () => { throw new Error("store unavailable"); },
      cfp,
      domainStore,
    );

    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/6",
      actorUri: "https://remote.example/users/alice",
      actorDocument: OLD_ACTOR,
      activity: SPAM_ACTIVITY,
      now: NOW,
    });

    // getMrfAdminStore() throws synchronously inside evaluateAp which calls evaluators
    // that each receive null store and return null — so result must be null (fail-open)
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AT path
// ---------------------------------------------------------------------------

describe("SpamEvaluator.evaluateAt", () => {
  it("returns null when all stores are null", async () => {
    const evaluator = new SpamEvaluator(() => null, null, null);
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "rkey1",
      record: { text: "buy now" },
    })!;

    const result = await evaluator.evaluateAt(envelope);
    expect(result).toBeNull();
  });

  it("triggers content-fingerprint for identical posts from multiple AT actors", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const makeEnvelope = (did: string) =>
      buildEnvelopeFromAT({
        did,
        collection: "app.bsky.feed.post",
        rkey: "rkey1",
        record: { text: "Identical spam post content for AT testing!" },
      })!;

    // Prime with 2 actors — at maxDistinctActors=2 threshold (no trigger yet)
    await evaluator.evaluateAt(makeEnvelope("did:plc:actor1"), { now: NOW });
    await evaluator.evaluateAt(makeEnvelope("did:plc:actor2"), { now: NOW });

    // 3rd actor pushes count to 3 (exceeds maxDistinctActors=2)
    const result = await evaluator.evaluateAt(makeEnvelope("did:plc:actor3"), { now: NOW });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("content-fingerprint");
    expect(["filter", "reject"]).toContain(result!.appliedAction);
  });

  it("triggers domain-reputation for blocked domains in AT facet links", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("blocked-at.example", false);
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc999",
      collection: "app.bsky.feed.post",
      rkey: "rkey2",
      record: {
        text: "Click here!",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 10 },
            features: [
              { $type: "app.bsky.richtext.facet#link", uri: "https://blocked-at.example/page" },
            ],
          },
        ],
      },
    })!;

    const result = await evaluator.evaluateAt(envelope, { now: NOW });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("domain-reputation");
  });

  it("returns null for a clean AT post", async () => {
    const mrf = await makeFullMrf();
    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const envelope = buildEnvelopeFromAT({
      did: "did:plc:clean123",
      collection: "app.bsky.feed.post",
      rkey: "rkey3",
      record: { text: "Just a normal post about my day." },
    })!;

    const result = await evaluator.evaluateAt(envelope, { now: NOW });
    expect(result).toBeNull();
  });

  it("skips actor-reputation for AT path (no external fetches)", async () => {
    // Even with actor-reputation set to max sensitivity, AT path must not trigger it
    const mrf = await makeFullMrf();
    // Make actor-reputation fire on absolutely everything
    const arConfig = await mrf.getModuleConfig("actor-reputation");
    if (!arConfig) throw new Error("missing");
    await mrf.setModuleConfig("actor-reputation", {
      ...arConfig,
      enabled: true,
      mode: "enforce",
      config: {
        ...arConfig.config,
        requireAvatar: true,
        requireBio: true,
        minSignalsToFlag: 1,
        action: "reject",
      },
    });

    const cfp = new InMemoryContentFingerprintStore();
    const domainStore = new InMemoryDomainReputationStore();
    const evaluator = new SpamEvaluator(() => mrf, cfp, domainStore);

    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc000",
      collection: "app.bsky.feed.post",
      rkey: "rkey4",
      record: { text: "Normal post, no avatar or bio signals available on AT path." },
    })!;

    // actor.hasAvatar and actor.hasBio are false in AT envelopes, but actor-reputation
    // must not run at all in evaluateAt — result must be null (clean post, no blocked domain)
    const result = await evaluator.evaluateAt(envelope, { now: NOW });
    expect(result).toBeNull();
  });
});
