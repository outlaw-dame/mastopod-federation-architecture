import { randomUUID } from "node:crypto";
import type { MRFAdminStore } from "../admin/mrf/store.js";
import type { MRFMode } from "../admin/mrf/types.js";
import {
  actorReputationRegistration,
  type ActorReputationConfig,
} from "../admin/mrf/registry/modules/actor-reputation.js";

export interface ActorReputationInput {
  activityId: string;
  actorUri: string;
  actorDocument: Record<string, unknown> | null;
  activity: Record<string, unknown>;
  originHost?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
}

export interface ActorReputationDecision {
  moduleId: "actor-reputation";
  traceId: string;
  mode: MRFMode;
  desiredAction: "label" | "filter" | "reject";
  appliedAction: "accept" | "label" | "filter" | "reject";
  signals: string[];
  signalCount: number;
  reason?: string;
}

const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

function extractAccountAgeDays(actorDoc: Record<string, unknown>, now: Date): number | null {
  const published = actorDoc["published"];
  if (typeof published !== "string") return null;
  const d = new Date(published);
  if (isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function extractFollowerCount(actorDoc: Record<string, unknown>): number | null {
  const followers = actorDoc["followers"];
  if (!followers || typeof followers !== "object" || Array.isArray(followers)) return null;
  const fo = followers as Record<string, unknown>;
  return typeof fo["totalItems"] === "number" ? (fo["totalItems"] as number) : null;
}

function extractObjectBody(activity: Record<string, unknown>): Record<string, unknown> | null {
  const obj = activity["object"];
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    return obj as Record<string, unknown>;
  }
  return null;
}

function countLinksInContent(obj: Record<string, unknown>): number {
  let content: string | null = typeof obj["content"] === "string" ? (obj["content"] as string) : null;
  if (!content) {
    const cm = obj["contentMap"];
    if (cm !== null && typeof cm === "object" && !Array.isArray(cm)) {
      const first = Object.values(cm as Record<string, unknown>).find((v) => typeof v === "string");
      content = (first as string) ?? null;
    }
  }
  if (!content) return 0;
  const matches = content.match(/<a\b[^>]*\bhref=/gi);
  return matches ? matches.length : 0;
}

function countTagsOfType(obj: Record<string, unknown>, type: string): number {
  const tags = obj["tag"];
  if (!Array.isArray(tags)) return 0;
  return tags.filter(
    (t) => t !== null && typeof t === "object" && (t as Record<string, unknown>)["type"] === type,
  ).length;
}

function countMentionsInCc(activity: Record<string, unknown>): number {
  const cc = activity["cc"];
  if (!Array.isArray(cc)) return 0;
  return cc.filter((uri) => typeof uri === "string" && uri !== AS_PUBLIC).length;
}

function buildSignals(
  config: ActorReputationConfig,
  actorDoc: Record<string, unknown> | null,
  activity: Record<string, unknown>,
  now: Date,
): string[] {
  const signals: string[] = [];
  const obj = extractObjectBody(activity);

  if (actorDoc) {
    if (config.maxAccountAgeDays > 0) {
      const ageDays = extractAccountAgeDays(actorDoc, now);
      if (ageDays !== null && ageDays <= config.maxAccountAgeDays) {
        signals.push("new-account");
      }
    }

    if (config.minFollowerCount > 0) {
      const followerCount = extractFollowerCount(actorDoc);
      if (followerCount !== null && followerCount < config.minFollowerCount) {
        signals.push("low-followers");
      }
    }

    if (config.requireAvatar && !actorDoc["icon"]) {
      signals.push("no-avatar");
    }

    if (config.requireBio && !actorDoc["summary"]) {
      signals.push("no-bio");
    }
  }

  if (obj) {
    if (config.maxLinksInContent > 0) {
      const linkCount = countLinksInContent(obj);
      if (linkCount > config.maxLinksInContent) {
        signals.push("link-density");
      }
    }

    if (config.maxHashtagCount > 0) {
      const hashtagCount = countTagsOfType(obj, "Hashtag");
      if (hashtagCount > config.maxHashtagCount) {
        signals.push("hashtag-flood");
      }
    }
  }

  if (config.maxMentionCount > 0) {
    const mentionCount = countMentionsInCc(activity);
    if (mentionCount > config.maxMentionCount) {
      signals.push("mention-storm");
    }
  }

  return signals;
}

export async function evaluateActorReputation(
  store: MRFAdminStore | null,
  input: ActorReputationInput,
  options?: {
    now?: () => string;
    requestId?: string;
  },
): Promise<ActorReputationDecision | null> {
  if (!store) return null;

  const moduleConfig = await store.getModuleConfig("actor-reputation");
  if (!moduleConfig || !moduleConfig.enabled) {
    return null;
  }

  const parsed = actorReputationRegistration.validateAndNormalizeConfig(moduleConfig.config, {
    existingConfig: actorReputationRegistration.getDefaultConfig(),
    partial: true,
  });
  const config = parsed.config as ActorReputationConfig;

  const nowFn = options?.now ?? (() => new Date().toISOString());
  const timestamp = nowFn();
  const nowDate = new Date(timestamp);
  const signals = buildSignals(config, input.actorDocument, input.activity, nowDate);

  if (signals.length < config.minSignalsToFlag) {
    return null;
  }

  const requestId = options?.requestId ?? randomUUID();
  const traceId = randomUUID();
  const desiredAction = config.action;
  const appliedAction = moduleConfig.mode === "enforce" ? desiredAction : "accept";
  const reason = config.traceReasons
    ? `Actor reputation: ${signals.length} signal(s) fired [${signals.join(", ")}] — threshold ${config.minSignalsToFlag}`
    : undefined;

  await store.appendTrace({
    traceId,
    requestId,
    activityId: input.activityId,
    actorId: input.actorUri,
    originHost: input.originHost,
    visibility: input.visibility,
    moduleId: "actor-reputation",
    mode: moduleConfig.mode,
    action: desiredAction,
    reason,
    createdAt: timestamp,
    redacted: false,
  });

  return {
    moduleId: "actor-reputation",
    traceId,
    mode: moduleConfig.mode,
    desiredAction,
    appliedAction,
    signals,
    signalCount: signals.length,
    reason,
  };
}
