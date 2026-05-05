import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureDefaultModuleConfigs } from "../admin/mrf/bootstrap.js";
import { InMemoryMRFAdminStore } from "../admin/mrf/store.memory.js";
import type { KeywordFilterConfig, KeywordRule } from "../admin/mrf/registry/modules/keyword-filter.js";
import { evaluateKeywordFilter } from "./KeywordFilterPolicy.js";

// ---------------------------------------------------------------------------
// Mock the embedding model so tests never touch the network or ONNX runtime.
//
// vi.hoisted() runs before all imports — its return value can be referenced
// safely inside vi.mock() factories, which are also hoisted.
//
// Controlled vectors (dim=4, unit-length):
//   VEC_A  = [1,0,0,0]  — "spam concept" pattern embedding
//   VEC_A2 = [1,0,0,0]  — identical to VEC_A → cosine similarity = 1.0
//   VEC_B  = [0,1,0,0]  — orthogonal to VEC_A → cosine similarity = 0.0
// ---------------------------------------------------------------------------

const tryEmbedMock = vi.hoisted(() =>
  vi.fn<(text: string) => Promise<Float32Array | null>>(),
);

vi.mock("./embedding/EmbeddingModel.js", () => ({
  tryEmbed: tryEmbedMock,
  prewarmEmbeddingModel: vi.fn(),
  EMBEDDING_DIM: 4,
}));

// ---------------------------------------------------------------------------
// Test vectors and helpers
// ---------------------------------------------------------------------------

const VEC_A  = new Float32Array([1, 0, 0, 0]); // "spam concept" pattern
const VEC_A2 = new Float32Array([1, 0, 0, 0]); // content sim=1.0 vs VEC_A
const VEC_B  = new Float32Array([0, 1, 0, 0]); // orthogonal — sim=0.0 vs VEC_A

const PATTERN_EMBEDDINGS = new Map<string, Float32Array>([
  ["spam concept",   VEC_A],
  ["unrelated topic", VEC_B],
]);

/**
 * Configure tryEmbed to return the known pattern embedding when the text is a
 * pattern key, or `contentEmb` otherwise (simulating an inbound post vector).
 */
function setupEmbedMock(contentEmb: Float32Array | null = VEC_A2): void {
  tryEmbedMock.mockImplementation(async (text: string) => {
    return PATTERN_EMBEDDINGS.get(text) ?? contentEmb;
  });
}

const NOW = () => "2026-04-28T12:00:00.000Z";

function rule(opts: Partial<KeywordRule> & { pattern: string }): KeywordRule {
  return {
    semantic: false,
    similarityThreshold: 0.75,
    wholeWord: false,
    caseSensitive: false,
    ...opts,
  };
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
  beforeEach(() => setupEmbedMock());

  it("returns null when mrfStore is null", async () => {
    const result = await evaluateKeywordFilter(null, { ...BASE_INPUT, text: "buy now at spam.example" });
    expect(result).toBeNull();
  });

  it("returns null when text is null", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: null })).toBeNull();
  });

  it("returns null when text is empty string", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "" })).toBeNull();
  });

  it("returns null when module is disabled", async () => {
    const mrf = new InMemoryMRFAdminStore(NOW);
    await ensureDefaultModuleConfigs(mrf, NOW);
    const current = await mrf.getModuleConfig("keyword-filter");
    if (!current) throw new Error("missing");
    await mrf.setModuleConfig("keyword-filter", {
      ...current,
      enabled: false,
      config: { ...current.config, rules: [rule({ pattern: "spam" })] },
    });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "this is spam" })).toBeNull();
  });

  it("returns null when rules list is empty", async () => {
    const mrf = await makeStore({ rules: [] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "this is spam" })).toBeNull();
  });

  it("returns null when text is shorter than minContentLength", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })], minContentLength: 100 });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "spam" })).toBeNull();
  });

  it("returns null when no rule matches", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "crypto" }), rule({ pattern: "buy now" })] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "just a normal post" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Literal matching
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — literal matching", () => {
  beforeEach(() => setupEmbedMock());

  it("matches a simple substring case-insensitively by default", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "buy now" })] });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "BUY NOW while stocks last!" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("buy now");
    expect(result!.similarity).toBeUndefined();
  });

  it("does NOT match when caseSensitive=true and case differs", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "Spam", caseSensitive: true })] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "this is spam content" }, { now: NOW })).toBeNull();
  });

  it("matches when caseSensitive=true and case is exact", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "Spam", caseSensitive: true })] });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "This is Spam" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("Spam");
  });

  it("does NOT match when wholeWord=true and pattern is mid-word", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "cat", wholeWord: true })] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "concatenation is a concept" }, { now: NOW })).toBeNull();
  });

  it("matches when wholeWord=true and word is isolated", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "cat", wholeWord: true })] });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "My cat sat on the mat" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("cat");
  });

  it("treats regex metacharacters as literals (escapes pattern)", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "buy.now" })] });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "buyXnow is not a thing" }, { now: NOW })).toBeNull();
    const match = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, activityId: "h://r/2", text: "please buy.now immediately" }, { now: NOW });
    expect(match).not.toBeNull();
    expect(match!.matchedPattern).toBe("buy.now");
  });

  it("returns the first matching rule (first-rule-wins ordering)", async () => {
    const mrf = await makeStore({
      rules: [rule({ pattern: "safe" }), rule({ pattern: "spam" }), rule({ pattern: "buy now" })],
    });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "this is spam and you should buy now" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("spam");
  });
});

// ---------------------------------------------------------------------------
// Semantic matching
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — semantic matching", () => {
  beforeEach(() => setupEmbedMock(VEC_A2)); // content similar to "spam concept"

  it("matches when content embedding is similar to pattern (sim ≥ threshold)", async () => {
    // "spam concept" → VEC_A; content → VEC_A2; similarity = 1.0 ≥ 0.75
    const mrf = await makeStore({
      rules: [rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 })],
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "purchase crypto tokens now for exclusive deals",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("spam concept");
    expect(result!.similarity).toBeCloseTo(1.0, 5);
  });

  it("does NOT match when content embedding is dissimilar (sim < threshold)", async () => {
    // Content → VEC_B (orthogonal to VEC_A); similarity = 0.0 < 0.75
    setupEmbedMock(VEC_B);
    const mrf = await makeStore({
      rules: [rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 })],
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "a perfectly normal post about my day",
    }, { now: NOW });
    expect(result).toBeNull();
  });

  it("includes similarity score in the decision result", async () => {
    const mrf = await makeStore({
      rules: [rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 })],
    });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "buy now exclusive deal" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(typeof result!.similarity).toBe("number");
    expect(result!.similarity).toBeGreaterThanOrEqual(0.75);
  });

  it("includes similarity in the trace reason when traceReasons=true", async () => {
    const mrf = await makeStore({
      rules: [rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 })],
      traceReasons: true,
    });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "exclusive deals right now" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/semantically matched/);
    expect(result!.reason).toContain("spam concept");
    expect(result!.reason).toMatch(/similarity/);
  });

  it("embeds content only once even when multiple semantic rules are present", async () => {
    tryEmbedMock.mockClear();
    setupEmbedMock(VEC_B); // Dissimilar — neither rule matches

    const mrf = await makeStore({
      rules: [
        rule({ pattern: "spam concept",   semantic: true, similarityThreshold: 0.9 }),
        rule({ pattern: "unrelated topic", semantic: true, similarityThreshold: 0.9 }),
      ],
    });

    const contentText = "unique-content-string-for-dedup-test";
    await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: contentText }, { now: NOW });

    // Content must be embedded exactly once, regardless of how many semantic rules exist.
    const contentCalls = tryEmbedMock.mock.calls.filter(([t]) => t === contentText);
    expect(contentCalls.length).toBe(1);
  });

  it("is fail-open when the model returns null (model unavailable)", async () => {
    // First call (content embed) returns null; subsequent calls return pattern embeddings.
    tryEmbedMock.mockImplementationOnce(async (_text: string) => null);

    const mrf = await makeStore({
      rules: [rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 })],
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "content that would semantically match if model were available",
    }, { now: NOW });
    // Model unavailable → fail-open → null
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mixed literal + semantic ordering
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — mixed literal + semantic ordering", () => {
  beforeEach(() => setupEmbedMock(VEC_A2)); // content matches "spam concept" semantically

  it("literal rule wins when it appears before a matching semantic rule", async () => {
    const mrf = await makeStore({
      rules: [
        rule({ pattern: "buy now", semantic: false }),
        rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 }),
      ],
    });
    const result = await evaluateKeywordFilter(mrf, {
      ...BASE_INPUT,
      text: "buy now at spam.example — exclusive deals!",
    }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("buy now");
    expect(result!.similarity).toBeUndefined();
  });

  it("semantic rule wins when all earlier literal rules miss", async () => {
    const mrf = await makeStore({
      rules: [
        rule({ pattern: "nonexistent-phrase", semantic: false }),
        rule({ pattern: "spam concept",       semantic: true, similarityThreshold: 0.75 }),
      ],
    });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "purchase crypto tokens now" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.matchedPattern).toBe("spam concept");
    expect(result!.similarity).toBeDefined();
  });

  it("does NOT embed content when there are only literal rules", async () => {
    tryEmbedMock.mockClear();
    const mrf = await makeStore({ rules: [rule({ pattern: "xyz-no-match" })] });
    await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "harmless content" }, { now: NOW });
    // No semantic rules — tryEmbed must never be called for the content text.
    const contentCalls = tryEmbedMock.mock.calls.filter(([t]) => t === "harmless content");
    expect(contentCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Enforce vs dry-run mode
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — mode handling", () => {
  beforeEach(() => setupEmbedMock());

  it("applies configured action in enforce mode", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })], action: "filter" }, "enforce");
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "this is spam" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.appliedAction).toBe("filter");
    expect(result!.desiredAction).toBe("filter");
  });

  it("applies accept in dry-run mode regardless of configured action", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })], action: "reject" }, "dry-run");
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "this is spam" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.desiredAction).toBe("reject");
    expect(result!.appliedAction).toBe("accept");
  });
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — trace", () => {
  beforeEach(() => setupEmbedMock());

  it("writes a trace entry on a literal match", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })] });
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

  it("writes a trace entry on a semantic match", async () => {
    const mrf = await makeStore({
      rules: [rule({ pattern: "spam concept", semantic: true, similarityThreshold: 0.75 })],
    });
    await evaluateKeywordFilter(
      mrf,
      { ...BASE_INPUT, activityId: "https://remote.example/activities/sem-trace", text: "buy now exclusive" },
      { now: NOW, requestId: "req-sem-trace" },
    );
    const traces = await mrf.listTraces({ limit: 10 });
    const trace = traces.items.find((t) => t.moduleId === "keyword-filter");
    expect(trace).toBeDefined();
    expect(trace!.activityId).toBe("https://remote.example/activities/sem-trace");
  });

  it("omits reason when traceReasons=false", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })], traceReasons: false });
    const result = await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "spam content" }, { now: NOW });
    expect(result).not.toBeNull();
    expect(result!.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// minContentLength boundary
// ---------------------------------------------------------------------------

describe("evaluateKeywordFilter — minContentLength", () => {
  beforeEach(() => setupEmbedMock());

  it("evaluates content exactly at minContentLength", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })], minContentLength: 4 });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "spam" }, { now: NOW })).not.toBeNull();
  });

  it("skips content one char below minContentLength", async () => {
    const mrf = await makeStore({ rules: [rule({ pattern: "spam" })], minContentLength: 5 });
    expect(await evaluateKeywordFilter(mrf, { ...BASE_INPUT, text: "spam" }, { now: NOW })).toBeNull();
  });
});
