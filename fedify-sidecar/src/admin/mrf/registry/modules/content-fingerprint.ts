import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { clampNumber, rejectUnknownKeys } from "../common.js";

export interface ContentFingerprintConfig {
  /** Minimum content length in chars (after normalization) before fingerprinting. 0 = fingerprint all. */
  minContentLength: number;
  /** Number of distinct actors sending identical content within the window to trigger a signal. */
  maxDistinctActors: number;
  /** Rolling lookback window in hours. */
  windowHours: number;
  /** Replace URLs with a placeholder before hashing so template spam with varied links still matches. */
  normalizeUrls: boolean;
  action: "label" | "filter" | "reject";
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    minContentLength: z.number().int().min(0).max(10_000),
    maxDistinctActors: z.number().int().min(2).max(1_000),
    windowHours: z.number().int().min(1).max(720),
    normalizeUrls: z.boolean(),
    action: z.enum(["label", "filter", "reject"]),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: ContentFingerprintConfig = {
  minContentLength: 50,
  maxDistinctActors: 5,
  windowHours: 24,
  normalizeUrls: true,
  action: "label",
  traceReasons: true,
};

function normalizeConfig(
  raw: Partial<ContentFingerprintConfig>,
  existing?: ContentFingerprintConfig,
): ContentFingerprintConfig {
  const baseline = existing ?? defaultConfig;
  return {
    ...baseline,
    ...raw,
    minContentLength: clampNumber(raw.minContentLength ?? baseline.minContentLength, 0, 10_000),
    maxDistinctActors: clampNumber(raw.maxDistinctActors ?? baseline.maxDistinctActors, 2, 1_000),
    windowHours: clampNumber(raw.windowHours ?? baseline.windowHours, 1, 720),
    normalizeUrls: raw.normalizeUrls ?? baseline.normalizeUrls,
    action: raw.action ?? baseline.action,
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };
}

export const contentFingerprintRegistration: ModuleRegistration<ContentFingerprintConfig> = {
  manifest: {
    id: "content-fingerprint",
    name: "Content Fingerprint",
    version: "1.0.0",
    kind: "wasm",
    description:
      "Detects copy-paste spam by tracking normalized content hashes across inbound activities. When the same content body arrives from more than N distinct actors within the configured time window, it is flagged as a coordinated spam pattern.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 15,
    configSchemaVersion: 1,
  },

  getDefaultConfig() {
    return { ...defaultConfig };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));
    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    return { config: normalizeConfig(parsed, opts.existingConfig) };
  },

  validateMode(mode, config) {
    if (mode === "enforce" && config.action === "reject" && config.maxDistinctActors < 3) {
      throw new Error(
        "Reject enforcement for content-fingerprint requires maxDistinctActors >= 3 to prevent false positives",
      );
    }
  },

  getUIHints() {
    return {
      category: "spam",
      shortDescription:
        "Flags copy-paste spam: identical content arriving from multiple distinct actors within a rolling time window.",
      docsUrl: "/docs/mrf/content-fingerprint",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: false,
      warnings: [
        "Cross-posted announcements (e.g. release notes, news items) may trigger this if many instances relay them simultaneously — tune maxDistinctActors and run in dry-run first.",
        "Reject enforcement with maxDistinctActors < 3 is blocked to reduce false positives.",
        "URL normalization groups template spam with varied tracking links — disable if legitimate cross-posts include different URLs.",
      ],
      invariants: [
        {
          code: "reject-actor-guardrail",
          message: "Reject enforcement requires maxDistinctActors >= 3",
        },
      ],
      safety: {
        requireSimulatorBeforeEnforce: true,
        enforceGuardrails: ["Reject enforcement requires maxDistinctActors >= 3"],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "minContentLength",
        label: "Minimum content length (chars)",
        description:
          "Posts shorter than this after normalization are not fingerprinted. Prevents false positives on short common phrases.",
        type: "integer",
        required: true,
        min: 0,
        max: 10000,
        step: 1,
        defaultValue: 50,
      },
      {
        key: "maxDistinctActors",
        label: "Distinct actors to trigger",
        description:
          "How many different accounts must send the same content within the window before the action fires. Minimum 2.",
        type: "integer",
        required: true,
        min: 2,
        max: 1000,
        step: 1,
        defaultValue: 5,
      },
      {
        key: "windowHours",
        label: "Detection window (hours)",
        description: "Rolling lookback window. Content sightings older than this are not counted.",
        type: "integer",
        required: true,
        min: 1,
        max: 720,
        step: 1,
        defaultValue: 24,
      },
      {
        key: "normalizeUrls",
        label: "Normalize URLs before hashing",
        description:
          "Replace URLs with a placeholder before fingerprinting. Groups template spam that varies only in link destination or tracking parameters.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
      {
        key: "action",
        label: "Decision action",
        description: "Action applied when the distinct-actor threshold is reached.",
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
        description: "Include the content hash and actor count in moderation traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
