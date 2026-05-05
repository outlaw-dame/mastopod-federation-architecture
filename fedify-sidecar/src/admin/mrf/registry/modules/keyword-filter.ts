import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { rejectUnknownKeys } from "../common.js";

export interface KeywordRule {
  /** The literal text or concept phrase to match. Must not be empty. */
  pattern: string;
  /**
   * When true, use semantic (embedding-based) similarity instead of literal
   * regex matching. The content is embedded with all-MiniLM-L6-v2 and
   * compared against the pattern embedding. Falls back to no-match (fail-open)
   * if the model is unavailable.
   */
  semantic: boolean;
  /**
   * Cosine similarity threshold [0, 1] for semantic rules. Values ≥ this
   * threshold are considered a match. Ignored when semantic=false.
   * 0.75 is a reliable "very similar" threshold for MiniLM-L6.
   */
  similarityThreshold: number;
  /** Only applies when semantic=false. Matches at word boundaries only. */
  wholeWord: boolean;
  /** Only applies when semantic=false. Case-sensitive literal matching. */
  caseSensitive: boolean;
}

export interface KeywordFilterConfig {
  /** Ordered list of keyword rules. First matching rule triggers the action. */
  rules: KeywordRule[];
  /** Minimum content length in chars (HTML-stripped) before any matching. 0 = check all. */
  minContentLength: number;
  action: "label" | "filter" | "reject";
  traceReasons: boolean;
}

const keywordRuleSchema = z
  .object({
    pattern: z.string().min(1).max(500),
    semantic: z.boolean().default(false),
    similarityThreshold: z.number().min(0).max(1).default(0.75),
    wholeWord: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
  })
  .strict();

const fullSchema = z
  .object({
    rules: z.array(keywordRuleSchema).max(1_000),
    minContentLength: z.number().int().min(0).max(10_000),
    action: z.enum(["label", "filter", "reject"]),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: KeywordFilterConfig = {
  rules: [],
  minContentLength: 0,
  action: "filter",
  traceReasons: true,
};

function normalizeRule(r: Partial<KeywordRule> & Pick<KeywordRule, "pattern">): KeywordRule {
  return {
    pattern: r.pattern,
    semantic: r.semantic ?? false,
    similarityThreshold: Math.max(0, Math.min(1, r.similarityThreshold ?? 0.75)),
    wholeWord: r.wholeWord ?? false,
    caseSensitive: r.caseSensitive ?? false,
  };
}

function normalizeConfig(
  raw: Partial<KeywordFilterConfig>,
  existing?: KeywordFilterConfig,
): KeywordFilterConfig {
  const baseline = existing ?? defaultConfig;
  const rawRules = raw.rules ?? baseline.rules;
  return {
    rules: rawRules.map(normalizeRule),
    minContentLength: Math.max(0, Math.min(10_000, raw.minContentLength ?? baseline.minContentLength)),
    action: raw.action ?? baseline.action,
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };
}

export const keywordFilterRegistration: ModuleRegistration<KeywordFilterConfig> = {
  manifest: {
    id: "keyword-filter",
    name: "Keyword Filter",
    version: "2.0.0",
    kind: "wasm",
    description:
      "Matches inbound activity content against an administrator-configured keyword list. Each rule can use literal regex matching (substring, whole-word, case-sensitive) or semantic embedding similarity via all-MiniLM-L6-v2 — catching paraphrased spam without requiring exact phrases. Applied to both ActivityPub and ATProto content.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 13,
    configSchemaVersion: 2,
  },

  getDefaultConfig() {
    return { ...defaultConfig, rules: [] };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));
    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    return { config: normalizeConfig(parsed as Partial<KeywordFilterConfig>, opts.existingConfig) };
  },

  validateMode(_mode, _config) {
    // No additional guardrails — the keyword list is the safety boundary.
  },

  getUIHints() {
    return {
      category: "spam",
      shortDescription:
        "Blocks or labels content matching administrator-configured rules — literal patterns or semantic concept matching via MiniLM-L6 embeddings.",
      docsUrl: "/docs/mrf/keyword-filter",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: false,
      warnings: [
        "Literal rules with common short words can produce many false positives — use whole-word matching and review dry-run traces before enforcing.",
        "Semantic rules embed every inbound post; the first semantic rule incurs a ~2–5 s model load on cold start. Use prewarmEmbeddingModel() at sidecar startup.",
        "Keyword rules are instance-level moderation, not per-user filtering. All inbound content is evaluated against all active rules.",
        "Whole-word boundary matching uses ASCII \\b anchors and may not handle non-Latin scripts correctly.",
        "Semantic matching degrades gracefully to no-match if the model is unavailable (fail-open).",
      ],
      invariants: [],
      safety: {
        requireSimulatorBeforeEnforce: true,
        enforceGuardrails: [],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "rules",
        label: "Keyword rules",
        description:
          "Ordered list of rules. Each specifies a pattern, matching mode (literal or semantic), and per-rule options. First matching rule wins.",
        type: "json",
        required: true,
        defaultValue: [],
        examples: [
          [{ pattern: "buy now", semantic: false, wholeWord: false, caseSensitive: false, similarityThreshold: 0.75 }],
          [{ pattern: "financial fraud scheme", semantic: true, similarityThreshold: 0.78, wholeWord: false, caseSensitive: false }],
        ],
      },
      {
        key: "minContentLength",
        label: "Minimum content length (chars)",
        description:
          "Activities with content shorter than this after HTML stripping are skipped. Set to 0 to evaluate all content.",
        type: "integer",
        required: true,
        min: 0,
        max: 10000,
        step: 1,
        defaultValue: 0,
      },
      {
        key: "action",
        label: "Decision action",
        description: "Action applied when content matches any rule.",
        type: "enum",
        required: true,
        defaultValue: "filter",
        options: [
          { value: "label", label: "Label" },
          { value: "filter", label: "Filter" },
          { value: "reject", label: "Reject" },
        ],
      },
      {
        key: "traceReasons",
        label: "Trace matched pattern",
        description: "Include the matched keyword pattern (and similarity score for semantic rules) in moderation traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
