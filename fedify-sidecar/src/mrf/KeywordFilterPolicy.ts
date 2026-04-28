import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFMode } from "../admin/mrf/types.js";
import {
  keywordFilterRegistration,
  type KeywordFilterConfig,
  type KeywordRule,
} from "../admin/mrf/registry/modules/keyword-filter.js";

export interface KeywordFilterInput {
  activityId: string;
  actorUri: string;
  /** Plain text (HTML stripped). Null when the activity carries no content body. */
  text: string | null;
  originHost?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
}

export interface KeywordFilterDecision {
  moduleId: "keyword-filter";
  traceId: string;
  mode: MRFMode;
  desiredAction: "label" | "filter" | "reject";
  appliedAction: "accept" | "label" | "filter" | "reject";
  matchedPattern: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function buildRuleRegex(rule: KeywordRule): RegExp {
  const escaped = rule.pattern.replace(ESCAPE_RE, "\\$&");
  const body = rule.wholeWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(body, rule.caseSensitive ? "" : "i");
}

function findFirstMatch(rules: KeywordRule[], text: string): string | null {
  for (const rule of rules) {
    try {
      if (buildRuleRegex(rule).test(text)) return rule.pattern;
    } catch {
      // Malformed pattern after escaping (e.g. trailing \b on non-word chars) — skip.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function evaluateKeywordFilter(
  mrfStore: MRFAdminStore | null,
  input: KeywordFilterInput,
  options?: { now?: () => string; requestId?: string },
): Promise<KeywordFilterDecision | null> {
  if (!mrfStore) return null;
  if (!input.text || input.text.length === 0) return null;

  const moduleConfig = await mrfStore.getModuleConfig("keyword-filter");
  if (!moduleConfig || !moduleConfig.enabled) return null;

  const parsed = keywordFilterRegistration.validateAndNormalizeConfig(moduleConfig.config, {
    existingConfig: keywordFilterRegistration.getDefaultConfig(),
    partial: true,
  });
  const config = parsed.config as KeywordFilterConfig;

  if (config.rules.length === 0) return null;
  if (input.text.length < config.minContentLength) return null;

  const matchedPattern = findFirstMatch(config.rules, input.text);
  if (!matchedPattern) return null;

  const nowFn = options?.now ?? (() => new Date().toISOString());
  const timestamp = nowFn();
  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const desiredAction = config.action;
  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";
  const reason = config.traceReasons
    ? `Keyword filter: content matched pattern "${matchedPattern}"`
    : undefined;

  await mrfStore.appendTrace({
    traceId,
    requestId,
    activityId: input.activityId,
    actorId: input.actorUri,
    originHost: input.originHost,
    visibility: input.visibility,
    moduleId: "keyword-filter",
    mode: moduleConfig.mode,
    action: desiredAction,
    reason,
    createdAt: timestamp,
    redacted: false,
  });

  return {
    moduleId: "keyword-filter",
    traceId,
    mode: moduleConfig.mode,
    desiredAction,
    appliedAction,
    matchedPattern,
    reason,
  };
}
