import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { clampNumber, dedupeStrings, rejectUnknownKeys } from "../common.js";

export interface TrustEvalConfig {
  thresholdLabel: number;
  thresholdDownrank: number;
  thresholdFilter: number;
  thresholdReject: number;
  defaultWeight: number;
  maxSourcesPerUser: number;
  allowedScopes: string[];
  enabledDecisionActions: Array<"label" | "downrank" | "filter" | "reject">;
  traceReasons: boolean;
}

const allowedDecisionActions = ["label", "downrank", "filter", "reject"] as const;

const fullSchema = z
  .object({
    thresholdLabel: z.number().min(0).max(1),
    thresholdDownrank: z.number().min(0).max(1),
    thresholdFilter: z.number().min(0).max(1),
    thresholdReject: z.number().min(0).max(1),
    defaultWeight: z.number().min(0).max(1),
    maxSourcesPerUser: z.number().int().min(1).max(500),
    allowedScopes: z.array(z.string()).max(50),
    enabledDecisionActions: z.array(z.enum(allowedDecisionActions)).min(1),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: TrustEvalConfig = {
  thresholdLabel: 0.3,
  thresholdDownrank: 0.45,
  thresholdFilter: 0.7,
  thresholdReject: 0.9,
  defaultWeight: 1,
  maxSourcesPerUser: 100,
  allowedScopes: [
    "filter:content",
    "filter:actor",
    "label:content",
    "label:actor",
    "rank:down",
    "rank:up",
  ],
  enabledDecisionActions: ["label", "downrank"],
  traceReasons: true,
};

function validateThresholdOrdering(cfg: TrustEvalConfig): void {
  if (
    !(
      cfg.thresholdLabel <= cfg.thresholdDownrank
      && cfg.thresholdDownrank <= cfg.thresholdFilter
      && cfg.thresholdFilter <= cfg.thresholdReject
    )
  ) {
    throw new Error("Threshold ordering must satisfy: label <= downrank <= filter <= reject");
  }
}

function normalizeConfig(raw: Partial<TrustEvalConfig>, existing?: TrustEvalConfig): TrustEvalConfig {
  const baseline = existing ?? defaultConfig;
  const merged: TrustEvalConfig = {
    ...baseline,
    ...raw,
    allowedScopes: dedupeStrings(raw.allowedScopes ?? baseline.allowedScopes),
    enabledDecisionActions: [
      ...new Set(raw.enabledDecisionActions ?? baseline.enabledDecisionActions),
    ],
    thresholdLabel: clampNumber(raw.thresholdLabel ?? baseline.thresholdLabel, 0, 1),
    thresholdDownrank: clampNumber(raw.thresholdDownrank ?? baseline.thresholdDownrank, 0, 1),
    thresholdFilter: clampNumber(raw.thresholdFilter ?? baseline.thresholdFilter, 0, 1),
    thresholdReject: clampNumber(raw.thresholdReject ?? baseline.thresholdReject, 0, 1),
    defaultWeight: clampNumber(raw.defaultWeight ?? baseline.defaultWeight, 0, 1),
    maxSourcesPerUser: Math.max(1, Math.min(500, raw.maxSourcesPerUser ?? baseline.maxSourcesPerUser)),
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };

  validateThresholdOrdering(merged);

  if (merged.enabledDecisionActions.length === 0) {
    throw new Error("At least one enabledDecisionAction is required");
  }

  return merged;
}

export const trustEvalRegistration: ModuleRegistration<TrustEvalConfig> = {
  manifest: {
    id: "trust-eval",
    name: "Trust Evaluation",
    version: "1.0.0",
    kind: "wasm",
    description:
      "Evaluates user trust sources and moderation packs to derive labels or reach penalties.",
    allowedActions: ["label", "downrank", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 30,
    configSchemaVersion: 1,
  },

  getDefaultConfig() {
    return { ...defaultConfig };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));

    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    const config = normalizeConfig(parsed, opts.existingConfig);

    return {
      config,
      warnings: config.enabledDecisionActions.includes("reject")
        ? [
            "Reject mode enabled for trust-eval; verify thresholds and simulator results before enforce mode.",
          ]
        : [],
    };
  },

  validateMode(mode, config) {
    if (
      mode === "enforce"
      && config.enabledDecisionActions.includes("reject")
      && config.thresholdReject < 0.8
    ) {
      throw new Error("Reject enforcement requires thresholdReject >= 0.8");
    }
  },

  getUIHints() {
    return {
      category: "trust",
      shortDescription: "Evaluates trusted moderation sources and packs to produce labels or reach penalties.",
      docsUrl: "/docs/mrf/trust-eval",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: true,
      warnings: [
        "Enabling reject actions in enforce mode can suppress inbound federation activity.",
        "Use simulator and dry-run traces before enabling reject behavior.",
      ],
      invariants: [
        {
          code: "threshold-ordering",
          message: "thresholdLabel <= thresholdDownrank <= thresholdFilter <= thresholdReject",
        },
      ],
      safety: {
        requireSimulatorBeforeEnforce: true,
        enforceGuardrails: ["Reject enforcement requires thresholdReject >= 0.8"],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "thresholdLabel",
        label: "Label threshold",
        description: "Minimum score needed to apply labels.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.3,
      },
      {
        key: "thresholdDownrank",
        label: "Downrank threshold",
        description: "Minimum score needed to apply a ranking penalty.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.45,
      },
      {
        key: "thresholdFilter",
        label: "Filter threshold",
        description: "Minimum score needed to hide or filter content.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.7,
      },
      {
        key: "thresholdReject",
        label: "Reject threshold",
        description: "Minimum score needed to reject content entirely.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.9,
      },
      {
        key: "defaultWeight",
        label: "Default source weight",
        description: "Fallback weight when a trust source does not specify one.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 1,
      },
      {
        key: "maxSourcesPerUser",
        label: "Maximum sources per user",
        description: "Upper limit on trust sources considered for a single user.",
        type: "integer",
        required: true,
        min: 1,
        max: 500,
        step: 1,
        defaultValue: 100,
      },
      {
        key: "allowedScopes",
        label: "Allowed trust scopes",
        description: "Scopes from user trust sources that this module may consider.",
        type: "multiselect",
        required: true,
        defaultValue: [
          "filter:content",
          "filter:actor",
          "label:content",
          "label:actor",
          "rank:down",
          "rank:up",
        ],
        options: [
          { value: "filter:content", label: "Filter content" },
          { value: "filter:actor", label: "Filter actors" },
          { value: "label:content", label: "Label content" },
          { value: "label:actor", label: "Label actors" },
          { value: "rank:down", label: "Downrank content" },
          { value: "rank:up", label: "Boost content" },
        ],
      },
      {
        key: "enabledDecisionActions",
        label: "Enabled decision actions",
        description: "Actions this module may emit during evaluation.",
        type: "multiselect",
        required: true,
        defaultValue: ["label", "downrank"],
        options: [
          { value: "label", label: "Label" },
          { value: "downrank", label: "Downrank" },
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
