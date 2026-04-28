import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { rejectUnknownKeys } from "../common.js";

export interface DomainReputationConfig {
  /** Action to apply when a blocked domain is found in the activity. */
  action: "label" | "filter" | "reject";
  /** Include the matched domain and action reason in moderation traces. */
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    action: z.enum(["label", "filter", "reject"]),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: DomainReputationConfig = {
  action: "filter",
  traceReasons: true,
};

function normalizeConfig(
  raw: Partial<DomainReputationConfig>,
  existing?: DomainReputationConfig,
): DomainReputationConfig {
  const baseline = existing ?? defaultConfig;
  return {
    action: raw.action ?? baseline.action,
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };
}

export const domainReputationRegistration: ModuleRegistration<DomainReputationConfig> = {
  manifest: {
    id: "domain-reputation",
    name: "Domain Reputation",
    version: "1.0.0",
    kind: "wasm",
    description:
      "Checks URLs and links in inbound activities against an administrator-curated blocked-domain list. Exact and subdomain matches are both supported. Complements content-fingerprint and actor-reputation spam detection.",
    allowedActions: ["label", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 12,
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

  validateMode(_mode, _config) {
    // No additional guardrails — the blocked-domain list is the safety boundary.
  },

  getUIHints() {
    return {
      category: "spam",
      shortDescription:
        "Blocks activities containing links to administrator-listed domains. Supports exact and wildcard subdomain matching.",
      docsUrl: "/docs/mrf/domain-reputation",
      supportsSimulator: true,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: false,
      warnings: [
        "Domain blocks apply to any URL in the activity's content — including link previews. Ensure the blocklist is maintained carefully to avoid false positives.",
        "Subdomain-match entries block all subdomains, including user-generated content hosts (e.g. blocking 'tumblr.com' would affect all tumblr blogs).",
      ],
      invariants: [],
      safety: {
        requireSimulatorBeforeEnforce: false,
        enforceGuardrails: [],
      },
    };
  },

  getUIFields() {
    return [
      {
        key: "action",
        label: "Decision action",
        description: "Action applied when a URL in the activity matches a blocked domain.",
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
        label: "Trace decision reasons",
        description: "Include the matched domain in moderation traces.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
