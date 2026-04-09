import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { dedupeStrings, rejectUnknownKeys } from "../common.js";

export interface SpamFilterConfig {
  keywordRules: string[];
  maxKeywordRules: number;
  minConfidence: number;
  action: "label" | "filter" | "reject";
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    keywordRules: z.array(z.string()).max(500),
    maxKeywordRules: z.number().int().min(1).max(500),
    minConfidence: z.number().min(0).max(1),
    action: z.enum(["label", "filter", "reject"]),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: SpamFilterConfig = {
  keywordRules: [],
  maxKeywordRules: 100,
  minConfidence: 0.8,
  action: "label",
  traceReasons: true,
};

export const spamFilterRegistration: ModuleRegistration<SpamFilterConfig> = {
  manifest: {
    id: "spam-filter",
    name: "Spam Filter",
    version: "1.0.0",
    kind: "wasm",
    description: "Rule-based spam detection over content and actor metadata.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 20,
    configSchemaVersion: 1,
  },

  getDefaultConfig() {
    return { ...defaultConfig };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));

    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    const existing = opts.existingConfig || defaultConfig;

    const nextMaxKeywordRules = parsed.maxKeywordRules ?? existing.maxKeywordRules;

    const config: SpamFilterConfig = {
      ...existing,
      ...parsed,
      keywordRules: dedupeStrings(parsed.keywordRules ?? existing.keywordRules).slice(0, nextMaxKeywordRules),
    };

    return { config };
  },

  validateMode(mode, config) {
    if (mode === "enforce" && config.action === "reject" && config.minConfidence < 0.9) {
      throw new Error("Reject enforcement for spam-filter requires minConfidence >= 0.9");
    }
  },

  getUIHints() {
    return {
      category: "spam",
      shortDescription: "Rule-based spam detection over content and actor metadata.",
      docsUrl: "/docs/mrf/spam-filter",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: true,
      warnings: [
        "Reject action should only be enabled with conservative confidence thresholds.",
      ],
      invariants: [
        {
          code: "reject-confidence-guardrail",
          message: "Reject enforcement requires minConfidence >= 0.9",
        },
      ],
      safety: {
        requireSimulatorBeforeEnforce: true,
        enforceGuardrails: ["Reject enforcement for spam-filter requires minConfidence >= 0.9"],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "keywordRules",
        label: "Keyword rules",
        description: "Keywords or phrases used by the rule engine.",
        type: "string-array",
        required: true,
        maxLength: 500,
        defaultValue: [],
      },
      {
        key: "maxKeywordRules",
        label: "Maximum keyword rules",
        description: "Upper bound applied when normalizing keyword rules.",
        type: "integer",
        required: true,
        min: 1,
        max: 500,
        step: 1,
        defaultValue: 100,
      },
      {
        key: "minConfidence",
        label: "Minimum confidence",
        description: "Decision confidence threshold from 0 to 1.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.8,
      },
      {
        key: "action",
        label: "Decision action",
        description: "Primary action emitted when a rule matches.",
        type: "enum",
        required: true,
        defaultValue: "label",
        options: [
          { value: "label", label: "Label" },
          { value: "filter", label: "Filter" },
          { value: "reject", label: "Reject" },
        ],
      },
      {
        key: "traceReasons",
        label: "Trace decision reasons",
        description: "Include human-readable reasons in moderation traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
