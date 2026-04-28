import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { rejectUnknownKeys } from "../common.js";

export interface KeywordRule {
  /** The literal text or phrase to match. Must not be empty. */
  pattern: string;
  /** When true, only matches the pattern at word boundaries (e.g. "cat" does not match "concatenate"). */
  wholeWord: boolean;
  /** When false (default), matching is case-insensitive. */
  caseSensitive: boolean;
}

export interface KeywordFilterConfig {
  /** Ordered list of keyword rules. First matching rule triggers the action. */
  rules: KeywordRule[];
  /** Minimum content length in chars (HTML-stripped) before keyword matching. 0 = check all. */
  minContentLength: number;
  action: "label" | "filter" | "reject";
  traceReasons: boolean;
}

const keywordRuleSchema = z
  .object({
    pattern: z.string().min(1).max(500),
    wholeWord: z.boolean(),
    caseSensitive: z.boolean(),
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

function normalizeConfig(
  raw: Partial<KeywordFilterConfig>,
  existing?: KeywordFilterConfig,
): KeywordFilterConfig {
  const baseline = existing ?? defaultConfig;
  return {
    rules: raw.rules ?? baseline.rules,
    minContentLength: Math.max(0, Math.min(10_000, raw.minContentLength ?? baseline.minContentLength)),
    action: raw.action ?? baseline.action,
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };
}

export const keywordFilterRegistration: ModuleRegistration<KeywordFilterConfig> = {
  manifest: {
    id: "keyword-filter",
    name: "Keyword Filter",
    version: "1.0.0",
    kind: "wasm",
    description:
      "Matches inbound activity content against an administrator-configured keyword list. Supports plain substring, whole-word boundary, and case-sensitive matching. Applied to both ActivityPub and ATProto content before domain reputation checks.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 13,
    configSchemaVersion: 1,
  },

  getDefaultConfig() {
    return { ...defaultConfig, rules: [] };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));
    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    return { config: normalizeConfig(parsed, opts.existingConfig) };
  },

  validateMode(_mode, _config) {
    // No additional guardrails — the keyword list is the safety boundary.
  },

  getUIHints() {
    return {
      category: "spam",
      shortDescription:
        "Blocks or labels content matching administrator-configured keyword rules. Supports whole-word and case-sensitive options per rule.",
      docsUrl: "/docs/mrf/keyword-filter",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: false,
      warnings: [
        "Common short words can produce many false positives — use whole-word matching and review dry-run traces before enforcing.",
        "Keyword rules are instance-level moderation, not per-user filtering. All inbound content is evaluated against all active rules.",
        "Whole-word boundary matching uses ASCII \\b anchors and may not correctly handle non-Latin scripts.",
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
          "Ordered list of keyword patterns. Each rule specifies a pattern, whether to match whole words only, and case sensitivity. First matching rule wins.",
        type: "json",
        required: true,
        defaultValue: [],
        examples: [
          [{ pattern: "buy now", wholeWord: false, caseSensitive: false }],
          [{ pattern: "spam", wholeWord: true, caseSensitive: false }],
        ],
      },
      {
        key: "minContentLength",
        label: "Minimum content length (chars)",
        description:
          "Activities with content shorter than this after HTML stripping are not evaluated. Set to 0 to evaluate all content.",
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
        description: "Action applied when content matches a keyword rule.",
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
        description: "Include the matched keyword pattern in moderation traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
