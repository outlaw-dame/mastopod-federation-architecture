/**
 * Shared helpers for FEP-9967 Question (poll) translation.
 *
 * A Question object carries:
 *   - type: "Question"
 *   - oneOf or anyOf: array of option Notes with replies.totalItems vote counts
 *   - content: the poll question body (HTML)
 *   - endTime / closed: optional expiry (consumers MUST treat `closed` = `endTime`)
 *   - votersCount (Mastodon extension): total unique voters
 *
 * Vote objects are Notes with name + inReplyTo + NO content property, sent via
 * Create to the poll author.
 */

import { z } from "zod";
import type {
  CanonicalPollCreateIntent,
  CanonicalPollDeleteIntent,
  CanonicalPollEditIntent,
  CanonicalPollVoteAddIntent,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalPollOption } from "../../canonical/CanonicalContent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import { htmlToCanonicalBlocks } from "../../text/HtmlToCanonicalBlocks.js";
import {
  asObject,
  asString,
  deriveAudience,
  extractId,
  extractFirstUrl,
  getActorId,
  getObjectType,
  toProvenance,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const actorSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

const bridgeSchema = z
  .object({
    originProtocol: z.enum(["activitypub", "atproto"]),
    originEventId: z.string().min(1),
    originAccountId: z.string().optional(),
    mirroredFromCanonicalIntentId: z.string().optional().nullable(),
    projectionMode: z.enum(["native", "mirrored"]).optional(),
  })
  .optional();

export const createQuestionActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Create"),
  actor: actorSchema,
  published: z.string().optional(),
  bridge: bridgeSchema,
  object: z.record(z.string(), z.unknown()),
});

export const updateQuestionActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Update"),
  actor: actorSchema,
  published: z.string().optional(),
  bridge: bridgeSchema,
  object: z.record(z.string(), z.unknown()),
});

export const deleteActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Delete"),
  actor: actorSchema,
  published: z.string().optional(),
  to: z.unknown().optional(),
  cc: z.unknown().optional(),
  bridge: bridgeSchema,
  object: z.unknown(),
});

// ---------------------------------------------------------------------------
// Supports guards
// ---------------------------------------------------------------------------

export function supportsCreateQuestion(input: unknown): boolean {
  const parsed = createQuestionActivitySchema.safeParse(input);
  return parsed.success && getObjectType(parsed.data.object) === "Question";
}

export function supportsUpdateQuestion(input: unknown): boolean {
  const parsed = updateQuestionActivitySchema.safeParse(input);
  return parsed.success && getObjectType(parsed.data.object) === "Question";
}

export function supportsDeleteQuestion(input: unknown): boolean {
  const parsed = deleteActivitySchema.safeParse(input);
  if (!parsed.success) return false;
  const obj = asObject(parsed.data.object);
  return getObjectType(obj) === "Question";
}

/**
 * A vote is a Create{Note} where the Note has a `name` (option text) and
 * `inReplyTo` (poll URI) but NO `content` property.
 *
 * FEP-9967 §"The structure of a vote is very similar to a direct reply.
 * It can be identified as a Note with name and inReplyTo properties,
 * but without a content property."
 */
export function supportsVote(input: unknown): boolean {
  const parsed = createQuestionActivitySchema.safeParse(input);
  if (!parsed.success) return false;
  const object = parsed.data.object;
  return (
    getObjectType(object) === "Note" &&
    typeof object["name"] === "string" &&
    object["name"].trim().length > 0 &&
    (typeof object["inReplyTo"] === "string" || extractId(object["inReplyTo"]) !== null) &&
    // No content property — distinguishes a vote from a reply
    !object["content"]
  );
}

// ---------------------------------------------------------------------------
// Translators
// ---------------------------------------------------------------------------

export async function translateCreateQuestion(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalPollCreateIntent | null> {
  const parsed = createQuestionActivitySchema.safeParse(input);
  if (!parsed.success || getObjectType(parsed.data.object) !== "Question") {
    return null;
  }
  return buildPollCreateIntent(parsed.data, ctx);
}

export async function translateUpdateQuestion(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalPollEditIntent | null> {
  const parsed = updateQuestionActivitySchema.safeParse(input);
  if (!parsed.success || getObjectType(parsed.data.object) !== "Question") {
    return null;
  }
  return buildPollEditIntent(parsed.data, ctx);
}

export async function translateDeleteQuestion(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalPollDeleteIntent | null> {
  const parsed = deleteActivitySchema.safeParse(input);
  if (!parsed.success) return null;
  const obj = asObject(parsed.data.object);
  if (getObjectType(obj) !== "Question") return null;

  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(parsed.data.actor);
  const targetId = extractId(parsed.data.object) ?? extractFirstUrl(parsed.data.object);
  if (!targetId) return null;

  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: targetId,
    activityPubObjectId: /^https?:\/\//.test(targetId) ? targetId : null,
    canonicalUrl: /^https?:\/\//.test(targetId) ? targetId : null,
  });

  const draft: Omit<CanonicalPollDeleteIntent, "canonicalIntentId"> = {
    kind: "PollDelete",
    sourceProtocol: "activitypub",
    sourceEventId: parsed.data.id,
    sourceAccountRef,
    createdAt: parsed.data.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: deriveAudience(parsed.data.to, parsed.data.cc),
    provenance: toProvenance(parsed.data.bridge, parsed.data.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
  };

  return { ...draft, canonicalIntentId: buildCanonicalIntentId(draft) };
}

export async function translateVote(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalPollVoteAddIntent | null> {
  const parsed = createQuestionActivitySchema.safeParse(input);
  if (!parsed.success) return null;

  const object = parsed.data.object;
  if (getObjectType(object) !== "Note") return null;

  const optionName = asString(object["name"]);
  const inReplyToId = extractId(object["inReplyTo"]) ?? asString(object["inReplyTo"]);
  if (!optionName || !inReplyToId) return null;
  if (object["content"]) return null; // has content → it's a reply, not a vote

  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(parsed.data.actor);
  const voteId = asString(object["id"]) ?? parsed.data.id;
  const voteUrl = extractFirstUrl(object["url"]) ?? voteId;

  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: voteId,
    activityPubObjectId: /^https?:\/\//.test(voteId) ? voteId : null,
    canonicalUrl: /^https?:\/\//.test(voteUrl) ? voteUrl : null,
  });
  const pollRef = await ctx.resolveObjectRef({
    canonicalObjectId: inReplyToId,
    activityPubObjectId: /^https?:\/\//.test(inReplyToId) ? inReplyToId : null,
    canonicalUrl: /^https?:\/\//.test(inReplyToId) ? inReplyToId : null,
  });

  const draft: Omit<CanonicalPollVoteAddIntent, "canonicalIntentId"> = {
    kind: "PollVoteAdd",
    sourceProtocol: "activitypub",
    sourceEventId: parsed.data.id,
    sourceAccountRef,
    createdAt: asString(object["published"]) ?? parsed.data.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "direct", // votes are sent directly to the poll author
    provenance: toProvenance(parsed.data.bridge, parsed.data.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
    pollRef,
    optionName: optionName.trim(),
  };

  return { ...draft, canonicalIntentId: buildCanonicalIntentId(draft) };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function buildPollCreateIntent(
  activity: z.infer<typeof createQuestionActivitySchema>,
  ctx: TranslationContext,
): Promise<CanonicalPollCreateIntent> {
  const { pollData, intent } = await buildPollBase(activity, ctx);
  const draft: Omit<CanonicalPollCreateIntent, "canonicalIntentId"> = {
    ...intent,
    kind: "PollCreate",
  };
  return { ...draft, canonicalIntentId: buildCanonicalIntentId(draft) };
}

async function buildPollEditIntent(
  activity: z.infer<typeof updateQuestionActivitySchema>,
  ctx: TranslationContext,
): Promise<CanonicalPollEditIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(activity.actor);
  const object = activity.object;
  const objectId = asString(object["id"]) ?? activity.id;

  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: objectId,
    activityPubObjectId: objectId,
    canonicalUrl: extractFirstUrl(object["url"]) ?? objectId,
  });

  const { options, mode } = extractPollOptions(object);
  const objectContent = asString(object["content"]) ?? "";
  const { plaintext } = htmlToCanonicalBlocks(objectContent);
  const question = plaintext.trim() || asString(object["name"]) || "";
  const endTime = asString(object["endTime"]) ?? asString(object["closed"]) ?? null;
  const votersCount = toOptionalCount(object["votersCount"]);
  const updatedAt =
    asString(object["updated"]) ??
    asString(object["published"]) ??
    activity.published ??
    now.toISOString();

  const draft: Omit<CanonicalPollEditIntent, "canonicalIntentId"> = {
    kind: "PollEdit",
    sourceProtocol: "activitypub",
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: updatedAt,
    observedAt: now.toISOString(),
    visibility: deriveAudience(object["to"], object["cc"]),
    provenance: toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
    question,
    mode,
    options,
    endTime,
    votersCount,
  };

  return { ...draft, canonicalIntentId: buildCanonicalIntentId(draft) };
}

interface PollBase {
  pollData: null;
  intent: Omit<CanonicalPollCreateIntent, "canonicalIntentId" | "kind">;
}

async function buildPollBase(
  activity: z.infer<typeof createQuestionActivitySchema>,
  ctx: TranslationContext,
): Promise<PollBase> {
  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(activity.actor);
  const object = activity.object;
  const objectId = asString(object["id"]) ?? activity.id;

  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: objectId,
    activityPubObjectId: objectId,
    canonicalUrl: extractFirstUrl(object["url"]) ?? objectId,
  });

  const { options, mode } = extractPollOptions(object);
  const objectContent = asString(object["content"]) ?? "";
  const { plaintext } = htmlToCanonicalBlocks(objectContent);
  const question = plaintext.trim() || asString(object["name"]) || "";
  const endTime = asString(object["endTime"]) ?? asString(object["closed"]) ?? null;
  const votersCount = toOptionalCount(object["votersCount"]);
  const published = asString(object["published"]) ?? activity.published ?? now.toISOString();

  return {
    pollData: null,
    intent: {
      sourceProtocol: "activitypub",
      sourceEventId: activity.id,
      sourceAccountRef,
      createdAt: published,
      observedAt: now.toISOString(),
      visibility: deriveAudience(object["to"], object["cc"]),
      provenance: toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null),
      warnings: [],
      object: objectRef,
      question,
      mode,
      options,
      endTime,
      votersCount,
    },
  };
}

function extractPollOptions(object: Record<string, unknown>): {
  options: CanonicalPollOption[];
  mode: "oneOf" | "anyOf";
} {
  const isAnyOf = Array.isArray(object["anyOf"]) && object["anyOf"].length > 0;
  const rawOptions: unknown[] = Array.isArray(object["anyOf"])
    ? object["anyOf"]
    : Array.isArray(object["oneOf"])
      ? object["oneOf"]
      : [];

  const mode: "oneOf" | "anyOf" = isAnyOf ? "anyOf" : "oneOf";

  const seen = new Set<string>();
  const options: CanonicalPollOption[] = [];

  for (const raw of rawOptions) {
    if (!raw || typeof raw !== "object") continue;
    const opt = raw as Record<string, unknown>;
    const name = asString(opt["name"]);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const replies = asObject(opt["replies"]);
    const voteCount = toOptionalCount(replies?.["totalItems"]) ?? 0;
    options.push({ name, voteCount });
  }

  return { options, mode };
}

function toOptionalCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return null;
}
