import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { clampNumber, dedupeStrings, rejectUnknownKeys } from "../common.js";

export interface MediaPolicyConfig {
  sensitiveLabels: string[];
  blockedLabels: string[];
  blockedPdqHashes: string[];
  trustedSources: string[];
  minSensitiveConfidence: number;
  minBlockedConfidence: number;
  minPdqQuality: number;
  pdqHammingThreshold: number;
  blockedAction: "filter" | "reject";
  applySensitiveFlag: boolean;
  setContentWarning: boolean;
  contentWarningText: string;
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    sensitiveLabels: z.array(z.string()).max(200),
    blockedLabels: z.array(z.string()).max(200),
    blockedPdqHashes: z.array(z.string()).max(200),
    trustedSources: z.array(z.string()).max(50),
    minSensitiveConfidence: z.number().min(0).max(1),
    minBlockedConfidence: z.number().min(0).max(1),
    minPdqQuality: z.number().int().min(0).max(100),
    pdqHammingThreshold: z.number().int().min(0).max(256),
    blockedAction: z.enum(["filter", "reject"]),
    applySensitiveFlag: z.boolean(),
    setContentWarning: z.boolean(),
    contentWarningText: z.string().max(160),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: MediaPolicyConfig = {
  sensitiveLabels: ["nsfw", "sexual", "nudity", "graphic-violence", "violence"],
  blockedLabels: ["csam", "csem"],
  blockedPdqHashes: [],
  trustedSources: [],
  minSensitiveConfidence: 0.65,
  minBlockedConfidence: 0.98,
  minPdqQuality: 70,
  pdqHammingThreshold: 15,
  blockedAction: "reject",
  applySensitiveFlag: true,
  setContentWarning: true,
  contentWarningText: "Sensitive media",
  traceReasons: true,
};

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePdqHash(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "").toLowerCase();
  if (/^[01]{256}$/.test(normalized)) {
    return normalized;
  }

  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return normalized
      .split("")
      .map((char) => Number.parseInt(char, 16).toString(2).padStart(4, "0"))
      .join("");
  }

  throw new Error("blockedPdqHashes entries must be 256-bit binary strings or 64-character hexadecimal values");
}

function normalizeConfig(raw: Partial<MediaPolicyConfig>, existing?: MediaPolicyConfig): MediaPolicyConfig {
  const baseline = existing ?? defaultConfig;
  const merged: MediaPolicyConfig = {
    ...baseline,
    ...raw,
    sensitiveLabels: dedupeStrings((raw.sensitiveLabels ?? baseline.sensitiveLabels).map(normalizeLabel)),
    blockedLabels: dedupeStrings((raw.blockedLabels ?? baseline.blockedLabels).map(normalizeLabel)),
    blockedPdqHashes: dedupeStrings((raw.blockedPdqHashes ?? baseline.blockedPdqHashes).map(normalizePdqHash)),
    trustedSources: dedupeStrings((raw.trustedSources ?? baseline.trustedSources).map(normalizeLabel)),
    minSensitiveConfidence: clampNumber(raw.minSensitiveConfidence ?? baseline.minSensitiveConfidence, 0, 1),
    minBlockedConfidence: clampNumber(raw.minBlockedConfidence ?? baseline.minBlockedConfidence, 0, 1),
    minPdqQuality: Math.max(0, Math.min(100, Math.trunc(raw.minPdqQuality ?? baseline.minPdqQuality))),
    pdqHammingThreshold: Math.max(
      0,
      Math.min(256, Math.trunc(raw.pdqHammingThreshold ?? baseline.pdqHammingThreshold)),
    ),
    contentWarningText: (raw.contentWarningText ?? baseline.contentWarningText).trim().slice(0, 160),
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
    applySensitiveFlag: raw.applySensitiveFlag ?? baseline.applySensitiveFlag,
    setContentWarning: raw.setContentWarning ?? baseline.setContentWarning,
    blockedAction: raw.blockedAction ?? baseline.blockedAction,
  };

  if (merged.minSensitiveConfidence > merged.minBlockedConfidence) {
    throw new Error("minSensitiveConfidence must be <= minBlockedConfidence");
  }

  return merged;
}

export const mediaPolicyRegistration: ModuleRegistration<MediaPolicyConfig> = {
  manifest: {
    id: "media-policy",
    name: "Media Policy",
    version: "1.0.0",
    kind: "wasm",
    description: "Applies canonical ActivityPub media policy from media-pipeline safety signals.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 35,
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
      warnings: config.blockedAction === "reject"
        ? ["Reject mode should be reserved for high-confidence illegal-abuse labels such as CSAM/CSEM."]
        : [],
    };
  },

  validateMode(mode, config) {
    if (mode === "enforce" && config.blockedAction === "reject" && config.minBlockedConfidence < 0.95) {
      throw new Error("Reject enforcement for media-policy requires minBlockedConfidence >= 0.95");
    }
  },

  getUIHints() {
    return {
      category: "policy",
      shortDescription: "Marks or blocks canonical AP media using trusted media-pipeline safety signals.",
      docsUrl: "/docs/mrf/media-policy",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: true,
      warnings: [
        "Prefer label/sensitive behavior for ambiguous NSFW media and reserve reject for illegal-abuse classes.",
      ],
      invariants: [
        {
          code: "media-confidence-ordering",
          message: "minSensitiveConfidence <= minBlockedConfidence",
        },
      ],
      safety: {
        requireSimulatorBeforeEnforce: true,
        enforceGuardrails: ["Reject enforcement for media-policy requires minBlockedConfidence >= 0.95"],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "sensitiveLabels",
        label: "Sensitive labels",
        description: "Labels that should mark media as sensitive on canonical AP resources.",
        type: "string-array",
        required: true,
        maxLength: 200,
        defaultValue: defaultConfig.sensitiveLabels,
      },
      {
        key: "blockedLabels",
        label: "Blocked labels",
        description: "Labels that should trigger stronger media filtering or rejection.",
        type: "string-array",
        required: true,
        maxLength: 200,
        defaultValue: defaultConfig.blockedLabels,
      },
      {
        key: "blockedPdqHashes",
        label: "Blocked image PDQ hashes",
        description:
          "Perceptual image hashes to block even when the file has been resized or lightly edited. Accepts 256-bit binary or 64-character hex values.",
        type: "string-array",
        required: true,
        maxLength: 200,
        defaultValue: [],
        placeholder: "011010... or 31ab07638e54b8fc...",
      },
      {
        key: "trustedSources",
        label: "Trusted sources",
        description: "Optional allow-list of scanner sources. Empty means all known sources are accepted.",
        type: "string-array",
        required: true,
        maxLength: 50,
        defaultValue: [],
      },
      {
        key: "minSensitiveConfidence",
        label: "Sensitive confidence threshold",
        description: "Minimum confidence needed to mark media as sensitive.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: defaultConfig.minSensitiveConfidence,
      },
      {
        key: "minBlockedConfidence",
        label: "Blocked confidence threshold",
        description: "Minimum confidence needed for filter/reject actions.",
        type: "number",
        required: true,
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: defaultConfig.minBlockedConfidence,
      },
      {
        key: "minPdqQuality",
        label: "PDQ minimum quality",
        description: "Only PDQ hashes with quality at or above this score are accepted for image-hash matching.",
        type: "integer",
        required: true,
        min: 0,
        max: 100,
        step: 1,
        defaultValue: defaultConfig.minPdqQuality,
      },
      {
        key: "pdqHammingThreshold",
        label: "PDQ Hamming threshold",
        description: "PDQ hashes are treated as matches only when their differing-bit distance is below this threshold.",
        type: "integer",
        required: true,
        min: 0,
        max: 256,
        step: 1,
        defaultValue: defaultConfig.pdqHammingThreshold,
      },
      {
        key: "blockedAction",
        label: "Blocked action",
        description: "Action to emit when a blocked label matches.",
        type: "enum",
        required: true,
        defaultValue: defaultConfig.blockedAction,
        options: [
          { value: "filter", label: "Filter" },
          { value: "reject", label: "Reject" },
        ],
      },
      {
        key: "applySensitiveFlag",
        label: "Apply sensitive flag",
        description: "Set the canonical AP resource sensitive flag when a decision matches.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
      {
        key: "setContentWarning",
        label: "Set content warning",
        description: "Populate the canonical summary field when a decision matches.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
      {
        key: "contentWarningText",
        label: "Content warning text",
        description: "Default summary text applied to canonical AP media.",
        type: "string",
        required: true,
        maxLength: 160,
        defaultValue: defaultConfig.contentWarningText,
      },
      {
        key: "traceReasons",
        label: "Trace decision reasons",
        description: "Include human-readable reasons in media-policy traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
