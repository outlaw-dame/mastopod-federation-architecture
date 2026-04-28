import { describe, expect, it } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import type { KeywordFilterConfig, KeywordRule } from "../admin/mrf/registry/modules/keyword-filter.js";
import { evaluateKeywordFilter } from "./KeywordFilterPolicy.js";

const NOW = () => "2026-04-28T12:00:00.000Z";

function rule(
  pattern: string,
  wholeWord = false,
  caseSensitive = false,
): KeywordRule {
  return { pattern, wholeWord, caseSensitive };
}

async function makeStore(
  overrides: Partial<KeywordFilterConfig> = {},
  mode: "dry-run" | "enforce" = "enforce",
) {
  const mrf = new InMemoryMRFAdminStore(NOW);
  await ensureDefaultModuleConfigs(mrf, NOW);
  const current = await mrf.getModuleConfig("keyword-filter");
  if (!current) throw new Error("keyword-filter module missing from registry");
  await mrf.setModuleConfig("keyword-filter", {
    ...current,
    enabled: true,
    mode,
    config: { ...current.config, ...overrides },
  });
  return mrf;
}

const BASE_INPUT = {
  activityId: "https://remote.example/activities/1",
  actorUri: "https://remote.example/users/alice",
};

// ---------------------------------------------------------------------------
// Null / disabled guards
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — null / disabled guards", () => {
  it("returns null when mrfStore is null", async () => {
    const result = await evaluateKeywordFilter(null, {
      ...BASE_INPUT,
      text: "buy now at spam.example",
    });
    expect(result).toBeNull();
  });

  it("returns null when text is null", async () => {
    const mrf = await makeStore({ rules: [rule("spam")] });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: null });
    expect(result).toBeNull();
  });

  it("returns null when text is empty string", async () => {
    const mrf = await makeStore({ rules: [rule("spam")] });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "" });
    expect(result).toBeNull();
  });

  it("returns null when module is disabled", async () => {
    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);
    const current = await mrf.getModuleConfig("keyword-filter");
    if (!current) throw new Error("missing");
    await mrf.setModuleConfig("keyword-filter", {
      ...current,
      enabled: false,
      config: { ...current.config, rules: [rule("spam")] },
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam content",
    });
    expect(result).toBeNull();
  });

  it("returns null when rules list is empty", async () => {
    const mrf = await makeStore({ rules: [] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam content",
    });
    expect(result).toBeNull();
  });

  it("returns null when text is shorter than minContentLength", async () => {
    const mrf = await makeStore({ rules: [rule("spam")], minContentLength: 100 });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "spam",
    });
    expect(result).toBeNull();
  });

  it("returns null when no rule matches", async () => {
    const mrf = await makeStore({ rules: [rule("crypto"), rule("buy now")] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "just a normal post about my day",
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Matching: plain substring (default — case-insensitive)
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — plain substring matching", () => {
  it("matches a simple substring (case-insensitive by default)", async () => {
    const mrf = await makeStore({ rules: [rule("buy now")] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "BUY NOW while stocks last!",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("buy now");
    expect(result!.moduleId).toBe("keyword-filter");
  });

  it("matches mid-word (substring, no whole-word flag)", async () => {
    const mrf = await makeStore({ rules: [rule("crypto")] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "My cryptocurrency portfolio grew today.",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("crypto");
  });
});

// ---------------------------------------------------------------------------
// Matching: case sensitivity
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — case sensitivity", () => {
  it("does NOT match when caseSensitive=true and case differs", async () => {
    const mrf = await makeStore({ rules: [rule("Spam", false, true)] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam content",
    }, { now: NOW });
    expect(result).toBeNull();
  });

  it("matches when caseSensitive=true and case is exact", async () => {
    const mrf = await makeStore({ rules: [rule("Spam", false, true)] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "This is Spam content",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("Spam");
  });
});

// ---------------------------------------------------------------------------
// Matching: whole-word boundary
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — whole-word boundary", () => {
  it("does NOT match when wholeWord=true and pattern is inside another word", async () => {
    const mrf = await makeStore({ rules: [rule("cat", true)] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "concatenation is a programming concept",
    }, { now: NOW });
    expect(result).toBeNull();
  });

  it("matches when wholeWord=true and word is isolated", async () => {
    const mrf = await makeStore({ rules: [rule("cat", true)] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "My cat sat on the mat",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("cat");
  });

  it("matches when wholeWord=true with punctuation boundary", async () => {
    const mrf = await makeStore({ rules: [rule("spam", true)] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "This is spam, please stop.",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("spam");
  });
});

// ---------------------------------------------------------------------------
// First-rule-wins ordering
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — first matching rule wins", () => {
  it("returns the first matching pattern when multiple rules could match", async () => {
    const mrf = await makeStore({
      rules: [rule("safe"), rule("spam"), rule("buy now")],
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam and you should buy now",
    }, { now: NOW });
    expect(result).not.toBeNull();
    // "safe" doesn't match — "spam" is the first matching rule
    expect(result!.matchedPattern).toBe("spam");
  });

  it("skips non-matching rules and returns the first match", async () => {
    const mrf = await makeStore({
      rules: [rule("zero"), rule("one"), rule("two"), rule("three")],
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "The number three is special",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("three");
  });
});

// ---------------------------------------------------------------------------
// Enforce vs dry-run mode
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — mode handling", () => {
  it("applies configured action in enforce mode", async () => {
    const mrf = await makeStore({ rules: [rule("spam")], action: "filter" }, "enforce");
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam content",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.appliedAction).toBe("filter");
    expect(result!.desiredAction).toBe("filter");
  });

  it("applies reject action in enforce mode when configured", async () => {
    const mrf = await makeStore({ rules: [rule("spam")], action: "reject" }, "enforce");
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam content",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.appliedAction).toBe("reject");
    expect(result!.desiredAction).toBe("reject");
  });

  it("applies accept in dry-run mode regardless of desiredAction", async () => {
    const mrf = await makeStore({ rules: [rule("spam")], action: "reject" }, "dry-run");
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "this is spam content",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.desiredAction).toBe("reject");
    expect(result!.appliedAction).toBe("accept");
  });
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — trace", () => {
  it("writes a trace entry on a match", async () => {
    const mrf = await makeStore({ rules: [rule("spam")] });
    await evaluateKeywordFilter(
      mrf,
      { ...BASE_INPUT, activityId: "https://remote.example/activities/trace-test", text: "this is spam" },
      { now: NOW, requestId: "req-kw-trace" },
    );
    const traces = await mrf.listTraces({ limit: 10 });
    const trace = traces.items.find((t) => t.moduleId === "keyword-filter");
    expect(trace).toBeDefined();
    expect(trace!.activityId).toBe("https://remote.example/activities/trace-test");
  });

  it("includes the matched pattern in the reason when traceReasons=true", async () => {
    const mrf = await makeStore({ rules: [rule("buy now")], traceReasons: true });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "buy now at spam.example",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("buy now");
  });

  it("omits reason when traceReasons=false", async () => {
    const mrf = await makeStore({ rules: [rule("spam")], traceReasons: false });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "spam content here",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// minContentLength boundary
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — minContentLength boundary", () => {
  it("evaluates content exactly at minContentLength (not below)", async () => {
    // text is exactly 4 chars, minContentLength is 4 — should evaluate
    const mrf = await makeStore({ rules: [rule("spam")], minContentLength: 4 });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "spam",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("spam");
  });

  it("skips content one char below minContentLength", async () => {
    const mrf = await makeStore({ rules: [rule("spam")], minContentLength: 5 });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "spam",
    }, { now: NOW });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regex special chars in pattern
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — regex special characters in patterns", () => {
  it("treats pattern as literal (special regex chars are escaped)", async () => {
    // Pattern contains regex metacharacters: "buy.now" should match the literal string "buy.now"
    // but NOT "buy_now" (because . is escaped to \\.)
    const mrf = await makeStore({ rules: [rule("buy.now")] });

    const noMatch = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "buyXnow is a thing",
    }, { now: NOW });
    expect(noMatch).toBeNull();

    const match = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      activityId: "https://remote.example/activities/2",
      text: "please buy.now immediately",
    }, { now: NOW });
    expect(match).not.toBeNull();
    expect(match!.matchedPattern).toBe("buy.now");
  });

  it("handles patterns with parentheses and brackets correctly", async () => {
    const mrf = await makeStore({ rules: [rule("(spam)")] });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "This is (spam) content",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("(spam)");
  });
});

// ---------------------------------------------------------------------------
// SpamEvaluator integration: keyword-filter on AP and AT paths
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — SpamEvaluator integration", () => {
  it("keyword-filter is reached on AP path when actor-reputation and CFP both pass", async () => {
    const { InMemoryContentFingerprintStore } = await import("../delivery/ContentFingerprintGuard.js");
    const { InMemoryDomainReputationStore } = await import("../delivery/DomainReputationStore.js");
    const { SpamEvaluator } = await import("./SpamEvaluator.js");

    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);

    // Enable keyword-filter only
    const kwConfig = await mrf.getModuleConfig("keyword-filter");
    if (!kwConfig) throw new Error("missing");
    await mrf.setModuleConfig("keyword-filter", {
      ...kwConfig,
      enabled: true,
      mode: "enforce",
      config: { ...kwConfig.config, rules: [rule("blocked-phrase")] },
    });

    const evaluator = new SpamEvaluator(() => mrf, new InMemoryContentFingerprintStore(), new InMemoryDomainReputationStore());
    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/kw-ap",
      actorUri: "https://remote.example/users/alice",
      actorDocument: {
        published: "2020-01-01T00:00:00Z",
        followers: { totalItems: 500 },
        icon: { url: "https://example.com/avatar.png" },
        summary: "<p>A real person.</p>",
      },
      activity: { object: { content: "<p>This post contains the blocked-phrase right here.</p>" } },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("keyword-filter");
    expect(["filter", "reject"]).toContain(result!.appliedAction);
  });

  it("keyword-filter is reached on AT path after CFP passes", async () => {
    const { InMemoryContentFingerprintStore } = await import("../delivery/ContentFingerprintGuard.js");
    const { InMemoryDomainReputationStore } = await import("../delivery/DomainReputationStore.js");
    const { SpamEvaluator } = await import("./SpamEvaluator.js");
    const { buildEnvelopeFromAT } = await import("./MRFActivityEnvelope.js");

    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);

    const kwConfig = await mrf.getModuleConfig("keyword-filter");
    if (!kwConfig) throw new Error("missing");
    await mrf.setModuleConfig("keyword-filter", {
      ...kwConfig,
      enabled: true,
      mode: "enforce",
      config: { ...kwConfig.config, rules: [rule("at-blocked")] },
    });

    const evaluator = new SpamEvaluator(() => mrf, new InMemoryContentFingerprintStore(), new InMemoryDomainReputationStore());
    const envelope = buildEnvelopeFromAT({
      did: "did:plc:abc123",
      collection: "app.bsky.feed.post",
      rkey: "rkey1",
      record: { text: "Hello world! This post contains at-blocked content." },
    })!;

    const result = await evaluator.evaluateAt(envelope, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("keyword-filter");
  });

  it("keyword-filter runs before domain-reputation on AP path", async () => {
    const { InMemoryContentFingerprintStore } = await import("../delivery/ContentFingerprintGuard.js");
    const { InMemoryDomainReputationStore } = await import("../delivery/DomainReputationStore.js");
    const { SpamEvaluator } = await import("./SpamEvaluator.js");

    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);

    const kwConfig = await mrf.getModuleConfig("keyword-filter");
    if (!kwConfig) throw new Error("missing");
    await mrf.setModuleConfig("keyword-filter", {
      ...kwConfig,
      enabled: true,
      mode: "enforce",
      config: { ...kwConfig.config, rules: [rule("blocked-word")] },
    });

    const domainStore = new InMemoryDomainReputationStore();
    await domainStore.addDomain("bad.example", false);

    // Activity has both a blocked keyword AND a blocked domain — keyword-filter wins.
    const evaluator = new SpamEvaluator(() => mrf, new InMemoryContentFingerprintStore(), domainStore);
    const result = await evaluator.evaluateAp({
      activityId: "https://remote.example/activities/order-test",
      actorUri: "https://remote.example/users/alice",
      actorDocument: {
        published: "2020-01-01T00:00:00Z",
        followers: { totalItems: 500 },
        icon: {},
        summary: "<p>bio</p>",
      },
      activity: {
        object: {
          content: '<p>blocked-word and <a href="https://bad.example/page">link</a></p>',
        },
      },
      now: NOW,
    });

    expect(result).not.toBeNull();
    expect(result!.moduleId).toBe("keyword-filter");
  });
});
