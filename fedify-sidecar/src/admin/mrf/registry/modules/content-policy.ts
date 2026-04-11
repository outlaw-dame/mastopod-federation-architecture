import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { dedupeStrings, rejectUnknownKeys } from "../common.js";

export interface ContentPolicyConfig {
  blockedLabels: string[];
  warnLabels: string[];
  allowedLanguages: string[];
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    blockedLabels: z.array(z.string()).max(200),
    warnLabels: z.array(z.string()).max(200),
    allowedLanguages: z.array(z.string()).max(100),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: ContentPolicyConfig = {
  blockedLabels: [],
  warnLabels: [],
  allowedLanguages: [],
  traceReasons: true,
};

export const contentPolicyRegistration: ModuleRegistration<ContentPolicyConfig> = {
  manifest: {
    id: "content-policy",
    name: "Content Policy",
    version: "1.0.0",
    kind: "wasm",
    description: "Applies host policy based on labels and content metadata.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 40,
    configSchemaVersion: 1,
  },

  getDefaultConfig() {
    return { ...defaultConfig };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));

    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    const existing = opts.existingConfig || defaultConfig;

    const config: ContentPolicyConfig = {
      ...existing,
      ...parsed,
      blockedLabels: dedupeStrings(parsed.blockedLabels ?? existing.blockedLabels),
      warnLabels: dedupeStrings(parsed.warnLabels ?? existing.warnLabels),
      allowedLanguages: dedupeStrings(parsed.allowedLanguages ?? existing.allowedLanguages),
    };

    return { config };
  },

  getUIHints() {
    return {
      category: "policy",
      shortDescription: "Applies host policy using labels, language controls, and warning classes.",
      docsUrl: "/docs/mrf/content-policy",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: true,
      warnings: [
        "Large blocked label lists can increase moderation latency.",
      ],
      safety: {
        requireSimulatorBeforeEnforce: true,
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "blockedLabels",
        label: "Blocked labels",
        description: "Labels that trigger hard filtering/rejection decisions.",
        type: "string-array",
        required: true,
        maxLength: 200,
        defaultValue: [],
      },
      {
        key: "warnLabels",
        label: "Warning labels",
        description: "Labels that trigger warnings but not hard blocks.",
        type: "string-array",
        required: true,
        maxLength: 200,
        defaultValue: [],
      },
      {
        key: "allowedLanguages",
        label: "Allowed languages",
        description: "Optional allow-list of language tags.",
        type: "string-array",
        required: true,
        maxLength: 100,
        defaultValue: [],
        placeholder: "en, fr, es",
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
