import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFMode } from "../admin/mrf/types.js";
import {
  keywordFilterRegistration,
  type KeywordFilterConfig,
  type KeywordRule,
} from "../admin/mrf/registry/modules/keyword-filter.js";
import { tryEmbed } from "./embedding/EmbeddingModel.js";
import {
  cosineSimilarity,
  getCachedPatternEmbedding,
  setCachedPatternEmbedding,
} from "./embedding/cosineSimilarity.js";

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
  /** Set for semantic matches. */
  similarity?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Literal matching
// ---------------------------------------------------------------------------

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function buildRuleRegex(rule: KeywordRule): RegExp {
  const escaped = rule.pattern.replace(ESCAPE_RE, "\\$&");
  const body = rule.wholeWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(body, rule.caseSensitive ? "" : "i");
}

// ---------------------------------------------------------------------------
// Semantic matching helpers
// ---------------------------------------------------------------------------

async function getPatternEmbedding(pattern: string): Promise<Float32Array | null> {
  const cached = getCachedPatternEmbedding(pattern);
  if (cached) return cached;
  const embedding = await tryEmbed(pattern);
  if (embedding) setCachedPatternEmbedding(pattern, embedding);
  return embedding;
}

// ---------------------------------------------------------------------------
// Ordered evaluation — literal and semantic rules interleaved
// ---------------------------------------------------------------------------

interface MatchResult {
  pattern: string;
  similarity?: number;
}

async function findFirstMatch(rules: KeywordRule[], text: string): Promise<MatchResult | null> {
  // Content embedding is computed at most once per evaluation call, lazily on
  // the first semantic rule encountered. undefined = not yet attempted,
  // null = model unavailable (fail-open for all subsequent semantic rules).
  let contentEmb: Float32Array | null | undefined;

  for (const rule of rules) {
    if (!rule.semantic) {
      // --- Literal path ---
      try {
        if (buildRuleRegex(rule).test(text)) return { pattern: rule.pattern };
      } catch {
        // Malformed pattern after escaping — skip (fail-open).
      }
    } else {
      // --- Semantic path ---
      if (contentEmb === undefined) {
        contentEmb = await tryEmbed(text); // null if model unavailable
      }
      if (!contentEmb) continue; // Model unavailable — skip semantic rules (fail-open).

      const patternEmb = await getPatternEmbedding(rule.pattern);
      if (!patternEmb) continue;

      const sim = cosineSimilarity(patternEmb, contentEmb);
      if (sim >= rule.similarityThreshold) return { pattern: rule.pattern, similarity: sim };
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

  const match = await findFirstMatch(config.rules, input.text);
  if (!match) return null;

  const nowFn = options?.now ?? (() => new Date().toISOString());
  const timestamp = nowFn();
  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const desiredAction = config.action;
  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";

  let reason: string | undefined;
  if (config.traceReasons) {
    reason = match.similarity !== undefined
      ? `Keyword filter: content semantically matched pattern "${match.pattern}" (similarity ${match.similarity.toFixed(3)})`
      : `Keyword filter: content matched pattern "${match.pattern}"`;
  }

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
    matchedPattern: match.pattern,
    similarity: match.similarity,
    reason,
  };
}
