import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFDecisionTrace, MRFMode } from "../admin/mrf/types.js";
import {
  activityPubSubjectPolicyRegistration,
  type ActivityPubSubjectPolicyConfig,
  type ActivityPubSubjectRule,
} from "../admin/mrf/registry/modules/activitypub-subject-policy.js";

export interface ActivityPubSubjectPolicyInput {
  activityId: string;
  actorUri: string;
  actorWebId?: string;
  originHost?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
}

export interface ActivityPubSubjectPolicyDecision {
  moduleId: "activitypub-subject-policy";
  traceId: string;
  mode: MRFMode;
  desiredAction: "accept" | "filter" | "reject";
  appliedAction: "accept" | "filter" | "reject";
  matchedRuleId: string;
  matchedOn: "actor-uri" | "webid" | "domain";
  matchedValue: string;
  reason?: string;
}

interface MatchResult {
  rule: ActivityPubSubjectRule;
  action: "filter" | "reject";
  matchedOn: "actor-uri" | "webid" | "domain";
  matchedValue: string;
}

function extractDomain(uri: string): string | undefined {
  try {
    return new URL(uri).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function rankRule(rule: ActivityPubSubjectRule): number {
  if (rule.action === "reject" && rule.actorUri) return 0;
  if (rule.action === "reject" && rule.webId) return 1;
  if (rule.action === "reject" && rule.domain) return 2;
  if (rule.action === "filter" && rule.actorUri) return 3;
  if (rule.action === "filter" && rule.webId) return 4;
  return 5;
}

function findMatch(
  config: ActivityPubSubjectPolicyConfig,
  input: ActivityPubSubjectPolicyInput,
): MatchResult | null {
  const actorUri = input.actorUri;
  const actorWebId = input.actorWebId;
  const actorDomain = input.originHost?.toLowerCase() || extractDomain(actorUri);
  const rules = [...config.rules].sort((left, right) => rankRule(left) - rankRule(right));

  for (const rule of rules) {
    if (rule.actorUri && rule.actorUri === actorUri) {
      return { rule, action: rule.action, matchedOn: "actor-uri", matchedValue: actorUri };
    }
    if (rule.webId && actorWebId && rule.webId === actorWebId) {
      return { rule, action: rule.action, matchedOn: "webid", matchedValue: actorWebId };
    }
    if (rule.domain && actorDomain && rule.domain === actorDomain) {
      return { rule, action: rule.action, matchedOn: "domain", matchedValue: actorDomain };
    }
  }

  return null;
}

async function appendTrace(store: MRFAdminStore, trace: MRFDecisionTrace): Promise<void> {
  await store.appendTrace(trace);
}

export async function evaluateActivityPubSubjectPolicy(
  store: MRFAdminStore | null,
  input: ActivityPubSubjectPolicyInput,
  options?: {
    now?: () => string;
    requestId?: string;
  },
): Promise<ActivityPubSubjectPolicyDecision | null> {
  if (!store) return null;

  const moduleConfig = await store.getModuleConfig("activitypub-subject-policy");
  if (!moduleConfig || !moduleConfig.enabled) {
    return null;
  }

  const parsed = activityPubSubjectPolicyRegistration.validateAndNormalizeConfig(moduleConfig.config, {
    existingConfig: activityPubSubjectPolicyRegistration.getDefaultConfig(),
    partial: true,
  });
  const config = parsed.config as ActivityPubSubjectPolicyConfig;
  const match = findMatch(config, input);
  if (!match) {
    return null;
  }

  const now = options?.now ?? (() => new Date().toISOString());
  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const reason = match.rule.reason
    ?? `${match.action === "reject" ? "Rejected" : "Filtered"} ActivityPub subject matched by ${match.matchedOn}: ${match.matchedValue}`;
  const desiredAction = match.action;
  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";

  await appendTrace(store, {
    traceId,
    requestId,
    activityId: input.activityId,
    actorId: input.actorUri,
    originHost: input.originHost ?? extractDomain(input.actorUri),
    visibility: input.visibility,
    moduleId: "activitypub-subject-policy",
    mode: moduleConfig.mode,
    action: desiredAction,
    reason: config.traceReasons ? reason : undefined,
    createdAt: now(),
    redacted: false,
  });

  return {
    moduleId: "activitypub-subject-policy",
    traceId,
    mode: moduleConfig.mode,
    desiredAction,
    appliedAction,
    matchedRuleId: match.rule.id,
    matchedOn: match.matchedOn,
    matchedValue: match.matchedValue,
    reason: config.traceReasons ? reason : undefined,
  };
}
