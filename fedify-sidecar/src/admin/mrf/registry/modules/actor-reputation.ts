import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { clampNumber, rejectUnknownKeys } from "../common.js";

export interface ActorReputationConfig {
  /** Account age window in days. Actor published within this window triggers a signal. 0 = disabled. */
  maxAccountAgeDays: number;
  /** Minimum follower count. Actor with fewer followers triggers a signal. 0 = disabled. */
  minFollowerCount: number;
  /** Max external links allowed in post content. Exceeding triggers a signal. 0 = disabled. */
  maxLinksInContent: number;
  /** Max hashtags allowed per post. Exceeding triggers a signal. 0 = disabled. */
  maxHashtagCount: number;
  /** Max mention/cc entries allowed per activity. Exceeding triggers a signal. 0 = disabled. */
  maxMentionCount: number;
  /** When true, an actor with no avatar contributes a signal. */
  requireAvatar: boolean;
  /** When true, an actor with no bio/summary contributes a signal. */
  requireBio: boolean;
  /** How many signals must fire simultaneously to trigger the configured action. */
  minSignalsToFlag: number;
  action: "label" | "filter" | "reject";
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    maxAccountAgeDays: z.number().int().min(0).max(365),
    minFollowerCount: z.number().int().min(0).max(100_000),
    maxLinksInContent: z.number().int().min(0).max(100),
    maxHashtagCount: z.number().int().min(0).max(200),
    maxMentionCount: z.number().int().min(0).max(500),
    requireAvatar: z.boolean(),
    requireBio: z.boolean(),
    minSignalsToFlag: z.number().int().min(1).max(10),
    action: z.enum(["label", "filter", "reject"]),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

// Defaults target the AntiLinkSpam pattern: new account (< 7 days) with
// zero followers posting links — needs 2 signals to trigger.
const defaultConfig: ActorReputationConfig = {
  maxAccountAgeDays: 7,
  minFollowerCount: 1,
  maxLinksInContent: 1,
  maxHashtagCount: 10,
  maxMentionCount: 20,
  requireAvatar: false,
  requireBio: false,
  minSignalsToFlag: 2,
  action: "label",
  traceReasons: true,
};

function normalizeConfig(raw: Partial<ActorReputationConfig>, existing?: ActorReputationConfig): ActorReputationConfig {
  const baseline = existing ?? defaultConfig;
  return {
    ...baseline,
    ...raw,
    maxAccountAgeDays: Math.max(0, Math.min(365, raw.maxAccountAgeDays ?? baseline.maxAccountAgeDays)),
    minFollowerCount: Math.max(0, Math.min(100_000, raw.minFollowerCount ?? baseline.minFollowerCount)),
    maxLinksInContent: Math.max(0, Math.min(100, raw.maxLinksInContent ?? baseline.maxLinksInContent)),
    maxHashtagCount: Math.max(0, Math.min(200, raw.maxHashtagCount ?? baseline.maxHashtagCount)),
    maxMentionCount: Math.max(0, Math.min(500, raw.maxMentionCount ?? baseline.maxMentionCount)),
    requireAvatar: raw.requireAvatar ?? baseline.requireAvatar,
    requireBio: raw.requireBio ?? baseline.requireBio,
    minSignalsToFlag: clampNumber(raw.minSignalsToFlag ?? baseline.minSignalsToFlag, 1, 10),
    action: raw.action ?? baseline.action,
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };
}

export const actorReputationRegistration: ModuleRegistration<ActorReputationConfig> = {
  manifest: {
    id: "actor-reputation",
    name: "Actor Reputation",
    version: "1.0.0",
    kind: "wasm",
    description:
      "Detects spam-indicative activity patterns: new accounts with no followers posting links or hashtag floods, mention storms, and profile incompleteness. Implements the fediverse AntiLinkSpam and HellThread patterns.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 18,
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
    if (mode === "enforce" && config.action === "reject" && config.minSignalsToFlag < 2) {
      throw new Error("Reject enforcement for actor-reputation requires minSignalsToFlag >= 2");
    }
  },

  getUIHints() {
    return {
      category: "spam",
      shortDescription:
        "Flags activities from new/unsocialised accounts with spam-pattern content: excessive links, hashtag floods, or mention storms (AntiLinkSpam + HellThread).",
      docsUrl: "/docs/mrf/actor-reputation",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: false,
      warnings: [
        "New legitimate users posting their first links may trigger this module — run in dry-run first and review traces.",
        "Reject with minSignalsToFlag=1 is blocked in enforce mode; at least 2 signals prevent false positives.",
        "Account age signals use the actor's self-reported published date; remote instances can falsify this field.",
      ],
      invariants: [
        {
          code: "reject-signal-guardrail",
          message: "Reject enforcement requires minSignalsToFlag >= 2",
        },
      ],
      safety: {
        requireSimulatorBeforeEnforce: true,
        enforceGuardrails: ["Reject enforcement requires minSignalsToFlag >= 2"],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "maxAccountAgeDays",
        label: "New account window (days)",
        description: "Accounts created within this many days contribute an age signal. Set to 0 to disable.",
        type: "integer",
        required: true,
        min: 0,
        max: 365,
        step: 1,
        defaultValue: 7,
      },
      {
        key: "minFollowerCount",
        label: "Minimum follower count",
        description: "Actors with fewer followers than this contribute a social-graph signal. Set to 0 to disable.",
        type: "integer",
        required: true,
        min: 0,
        max: 100000,
        step: 1,
        defaultValue: 1,
      },
      {
        key: "maxLinksInContent",
        label: "Maximum links in post",
        description: "Posts with more external links than this contribute a link-density signal. Set to 0 to disable.",
        type: "integer",
        required: true,
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 1,
      },
      {
        key: "maxHashtagCount",
        label: "Maximum hashtags",
        description: "Posts with more hashtags than this contribute a hashtag-flood signal. Set to 0 to disable.",
        type: "integer",
        required: true,
        min: 0,
        max: 200,
        step: 1,
        defaultValue: 10,
      },
      {
        key: "maxMentionCount",
        label: "Maximum mentions",
        description: "Activities with more mentions/CC entries than this contribute a mention-storm signal. Set to 0 to disable.",
        type: "integer",
        required: true,
        min: 0,
        max: 500,
        step: 1,
        defaultValue: 20,
      },
      {
        key: "requireAvatar",
        label: "Require actor avatar",
        description: "When enabled, actors with no avatar contribute a profile-incompleteness signal.",
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      {
        key: "requireBio",
        label: "Require actor bio",
        description: "When enabled, actors with no bio/summary contribute a profile-incompleteness signal.",
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      {
        key: "minSignalsToFlag",
        label: "Signals required to flag",
        description: "How many signals must fire simultaneously before the action is applied. Default 2 prevents single-signal false positives.",
        type: "integer",
        required: true,
        min: 1,
        max: 10,
        step: 1,
        defaultValue: 2,
      },
      {
        key: "action",
        label: "Decision action",
        description: "Action applied when enough signals fire. Start with Label, graduate to Filter after reviewing dry-run traces.",
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
        description: "Include per-signal reasons in moderation traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
