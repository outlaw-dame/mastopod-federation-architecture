import { z } from "zod";
import type { ModuleRegistration } from "../types.js";
import { rejectUnknownKeys } from "../common.js";

export interface ActivityPubSubjectRule {
  id: string;
  action: "filter" | "reject";
  actorUri?: string;
  webId?: string;
  domain?: string;
  reason?: string;
  createdAt?: string;
  createdBy?: string;
}

export interface ActivityPubSubjectPolicyConfig {
  rules: ActivityPubSubjectRule[];
  traceReasons: boolean;
}

const fullSchema = z
  .object({
    rules: z.array(z.unknown()).max(1_000),
    traceReasons: z.boolean(),
  })
  .strict();

const patchSchema = fullSchema.partial().strict();

const defaultConfig: ActivityPubSubjectPolicyConfig = {
  rules: [],
  traceReasons: true,
};

function parseHttpUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${field} entries must be valid URLs`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} entries must use http or https`);
  }

  return parsed;
}

function normalizeActorUri(value: string, field: string): string {
  const parsed = parseHttpUrl(value, field);
  parsed.hash = "";
  return parsed.toString();
}

function normalizeWebId(value: string, field: string): string {
  return parseHttpUrl(value, field).toString();
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Domain entries must not be empty");
  }

  const urlLike = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(urlLike);
  } catch {
    throw new Error("Domain entries must be valid hostnames");
  }

  if (!parsed.hostname) {
    throw new Error("Domain entries must be valid hostnames");
  }

  return parsed.hostname.toLowerCase();
}

function normalizeRule(raw: Record<string, unknown>): ActivityPubSubjectRule {
  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  if (!id) {
    throw new Error("Each rule must include a non-empty id");
  }

  const action = raw["action"];
  if (action !== "filter" && action !== "reject") {
    throw new Error(`Rule ${id} must use action 'filter' or 'reject'`);
  }

  const actorUri = typeof raw["actorUri"] === "string" && raw["actorUri"].trim()
    ? normalizeActorUri(raw["actorUri"], `rules[${id}].actorUri`)
    : undefined;
  const webId = typeof raw["webId"] === "string" && raw["webId"].trim()
    ? normalizeWebId(raw["webId"], `rules[${id}].webId`)
    : undefined;
  const domain = typeof raw["domain"] === "string" && raw["domain"].trim()
    ? normalizeDomain(raw["domain"])
    : undefined;

  if (!actorUri && !webId && !domain) {
    throw new Error(`Rule ${id} must include actorUri, webId, or domain`);
  }

  const reason = typeof raw["reason"] === "string" ? raw["reason"].trim().slice(0, 500) : undefined;
  const createdAt = typeof raw["createdAt"] === "string" && raw["createdAt"].trim()
    ? new Date(raw["createdAt"]).toISOString()
    : undefined;
  const createdBy = typeof raw["createdBy"] === "string" ? raw["createdBy"].trim().slice(0, 128) : undefined;

  return {
    id,
    action,
    ...(actorUri ? { actorUri } : {}),
    ...(webId ? { webId } : {}),
    ...(domain ? { domain } : {}),
    ...(reason ? { reason } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(createdBy ? { createdBy } : {}),
  };
}

function normalizeConfig(
  raw: { rules?: unknown[]; traceReasons?: boolean },
  existing?: ActivityPubSubjectPolicyConfig,
): ActivityPubSubjectPolicyConfig {
  const baseline = existing ?? defaultConfig;
  const normalizedRules = new Map<string, ActivityPubSubjectRule>();
  for (const entry of raw.rules ?? baseline.rules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("rules entries must be objects");
    }
    const normalized = normalizeRule(entry as unknown as Record<string, unknown>);
    normalizedRules.set(normalized.id, normalized);
  }

  return {
    ...baseline,
    ...raw,
    rules: [...normalizedRules.values()],
    traceReasons: raw.traceReasons ?? baseline.traceReasons,
  };
}

export const activityPubSubjectPolicyRegistration: ModuleRegistration<ActivityPubSubjectPolicyConfig> = {
  manifest: {
    id: "activitypub-subject-policy",
    name: "AP Subject Policy",
    version: "1.0.0",
    kind: "wasm",
    description: "Applies exact-match ActivityPub actor, WebID, and domain moderation rules on verified inbound traffic.",
    allowedActions: ["filter", "reject"],
    defaultMode: "enforce",
    defaultPriority: 15,
    configSchemaVersion: 1,
  },

  getDefaultConfig() {
    return { ...defaultConfig };
  },

  validateAndNormalizeConfig(raw, opts = {}) {
    rejectUnknownKeys(raw, Object.keys(defaultConfig));

    const parsed = opts.partial ? patchSchema.parse(raw) : fullSchema.parse(raw);
    return {
      config: normalizeConfig(parsed, opts.existingConfig),
    };
  },

  getUIHints() {
    return {
      category: "policy",
      shortDescription: "Exact-match ActivityPub subject rules for verified inbound actors, WebIDs, and domains.",
      docsUrl: "/docs/mrf/activitypub-subject-policy",
      supportsSimulator: false,
      supportsDryRun: true,
      supportsEnforce: true,
      supportsStopOnMatch: true,
      warnings: [
        "Filter rules keep ActivityPods forwarding but suppress public surfacing and bridge projection.",
        "Reject rules stop inbound activities before ActivityPods forwarding and stream publication.",
      ],
    };
  },

  getUIFields() {
    return [
      {
        key: "rules",
        label: "Subject rules",
        description:
          "Dashboard-managed JSON rules. Each rule needs an id, action ('filter' or 'reject'), and at least one of actorUri, webId, or domain.",
        type: "json",
        required: true,
        defaultValue: [],
        examples: [
          [
            {
              id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
              action: "reject",
              actorUri: "https://remote.example/users/alice",
              reason: "Manual provider block",
            },
          ],
        ],
      },
      {
        key: "traceReasons",
        label: "Trace decision reasons",
        description: "Include human-readable reasons in MRF traces when a subject rule matches.",
        type: "boolean",
        required: true,
        defaultValue: true,
      },
    ];
  },
};
