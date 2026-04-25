import { z } from "zod";
import type {
  CanonicalFollowAddIntent,
  CanonicalFollowRemoveIntent,
  CanonicalIntent,
  CanonicalPostCreateIntent,
  CanonicalReactionAddIntent,
  CanonicalReactionRemoveIntent,
  CanonicalShareAddIntent,
  CanonicalShareRemoveIntent,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import { isApEmojiReactionActivity, parseApEmojiReaction, type ApEmojiReaction } from "../../../utils/apEmojiReactions.js";
import { htmlToCanonicalBlocks } from "../../text/HtmlToCanonicalBlocks.js";
import {
  asString,
  buildAttachments,
  buildInlineLinkAndTagFacets,
  buildTagFacets,
  resolveOptionalObjectRef,
} from "./shared.js";

const actorSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
  }).passthrough(),
]);

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

const baseActivitySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  actor: actorSchema,
  object: z.unknown(),
  published: z.string().optional(),
  to: z.unknown().optional(),
  cc: z.unknown().optional(),
  bridge: bridgeSchema,
});

type ParsedActivity = z.infer<typeof baseActivitySchema>;

const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";
const ACTOR_TYPES = new Set(["Person", "Group", "Organization", "Application", "Service"]);

export function supportsSocialActivity(input: unknown, type: "Like" | "Announce" | "Follow" | "Undo"): boolean {
  const parsed = baseActivitySchema.safeParse(input);
  return parsed.success && parsed.data.type === type;
}

export async function translateEmojiReactionActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  const parsed = baseActivitySchema.safeParse(input);
  if (!parsed.success || !isApEmojiReactionActivity(input)) {
    return null;
  }

  const reaction = parseApEmojiReaction(input);
  if (!reaction) {
    return null;
  }

  return buildReactionIntent(parsed.data, ctx, "ReactionAdd", null, reaction);
}

export async function translateLikeActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  const parsed = baseActivitySchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== "Like") {
    return null;
  }

  return buildReactionIntent(parsed.data, ctx, "ReactionAdd");
}

export async function translateAnnounceActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  const parsed = baseActivitySchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== "Announce") {
    return null;
  }

  // FEP-dd4b: Announce with a non-empty `content` field is a quote post with commentary.
  // Translate it as a PostCreate with quoteOf set to the announced object.
  const rawContent = asString((input as Record<string, unknown>)["content"]);
  if (rawContent?.trim()) {
    return buildQuotePostIntentFromAnnounce(
      parsed.data,
      rawContent.trim(),
      input as Record<string, unknown>,
      ctx,
    );
  }

  return buildShareIntent(parsed.data, ctx, "ShareAdd");
}

export async function translateFollowActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  const parsed = baseActivitySchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== "Follow") {
    return null;
  }

  return buildFollowIntent(parsed.data, ctx, "FollowAdd");
}

export async function translateUndoActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  const parsed = baseActivitySchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== "Undo") {
    return null;
  }

  const object = await resolveUndoTargetActivity(parsed.data, ctx);
  if (!object) {
    return null;
  }
  const nestedType = typeof object["type"] === "string" ? object["type"] : null;
  if (!nestedType) {
    return null;
  }

  const outerActor = getActorId(parsed.data.actor);
  const nestedActor = extractId(object["actor"]);
  if (nestedActor && nestedActor !== outerActor) {
    return null;
  }

  switch (nestedType) {
    case "Like":
      return buildReactionIntent(
        parsed.data,
        ctx,
        "ReactionRemove",
        object,
        parseApEmojiReaction(object),
      );
    case "EmojiReact": {
      const reaction = parseApEmojiReaction(object);
      if (!reaction) {
        return null;
      }
      return buildReactionIntent(parsed.data, ctx, "ReactionRemove", object, reaction);
    }
    case "Announce":
      return buildShareIntent(parsed.data, ctx, "ShareRemove", object);
    case "Follow":
      return buildFollowIntent(parsed.data, ctx, "FollowRemove", object);
    default:
      return null;
  }
}

async function resolveUndoTargetActivity(
  activity: ParsedActivity,
  ctx: TranslationContext,
): Promise<Record<string, unknown> | null> {
  const inlineObject = asObject(activity.object);
  if (inlineObject) {
    if (typeof inlineObject["type"] === "string" && inlineObject["type"].trim().length > 0) {
      return inlineObject;
    }

    const activityId = extractId(inlineObject);
    if (!activityId || !ctx.resolveActivityObject) {
      return null;
    }

    return ctx.resolveActivityObject(activityId, {
      expectedActorUri: getActorId(activity.actor),
    });
  }

  const activityId = extractId(activity.object);
  if (!activityId || !ctx.resolveActivityObject) {
    return null;
  }

  return ctx.resolveActivityObject(activityId, {
    expectedActorUri: getActorId(activity.actor),
  });
}

async function buildReactionIntent(
  activity: ParsedActivity,
  ctx: TranslationContext,
  kind: "ReactionAdd" | "ReactionRemove",
  activityObject: Record<string, unknown> | null = null,
  emojiReaction: ApEmojiReaction | null = null,
): Promise<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({
    activityPubActorUri: getActorId(activity.actor),
  });
  const targetId = extractId((activityObject ?? asObject(activity.object))?.["object"] ?? activity.object);
  if (!targetId) {
    return null;
  }

  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: targetId,
    activityPubObjectId: targetId,
    canonicalUrl: extractFirstUrl((activityObject ?? asObject(activity.object))?.["object"]) ?? targetId,
  });
  const draft = {
    sourceProtocol: "activitypub" as const,
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: activity.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: deriveAudience(activity.to, activity.cc),
    provenance: toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
    reactionType: emojiReaction ? "emoji" as const : "like" as const,
    reactionContent: emojiReaction?.content ?? null,
    reactionEmoji: emojiReaction?.customEmoji
      ? {
          shortcode: emojiReaction.customEmoji.shortcode,
          emojiId: emojiReaction.customEmoji.emojiId ?? null,
          iconUrl: emojiReaction.customEmoji.iconUrl ?? null,
          mediaType: emojiReaction.customEmoji.mediaType ?? null,
          updatedAt: emojiReaction.customEmoji.updatedAt ?? null,
          alternateName: emojiReaction.customEmoji.alternateName ?? null,
          domain: emojiReaction.customEmoji.domain ?? null,
        }
      : null,
  };

  if (kind === "ReactionAdd") {
    const createDraft: Omit<CanonicalReactionAddIntent, "canonicalIntentId"> = {
      kind,
      ...draft,
    };
    return {
      ...createDraft,
      canonicalIntentId: buildCanonicalIntentId(createDraft),
    };
  }

  const removeDraft: Omit<CanonicalReactionRemoveIntent, "canonicalIntentId"> = {
    kind,
    ...draft,
  };
  return {
    ...removeDraft,
    canonicalIntentId: buildCanonicalIntentId(removeDraft),
  };
}

/**
 * FEP-dd4b: Build a PostCreate intent from an Announce activity that carries commentary content.
 * The quoted object is the Announce's `object`; the commentary is the Announce's `content`.
 */
async function buildQuotePostIntentFromAnnounce(
  activity: ParsedActivity,
  contentHtml: string,
  rawActivity: Record<string, unknown>,
  ctx: TranslationContext,
): Promise<CanonicalPostCreateIntent | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(activity.actor);
  // The Announce activity's ID serves as the quote post's object ID.
  const objectId = activity.id;
  const objectUrl = extractFirstUrl(rawActivity["url"]) ?? objectId;
  const { plaintext, blocks, warning } = htmlToCanonicalBlocks(contentHtml);
  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: objectId,
    activityPubObjectId: objectId,
    canonicalUrl: objectUrl,
  });
  // The quoted post is the Announce's `object`.
  const quotedId = extractId(activity.object);
  const quoteOf = quotedId
    ? await ctx.resolveObjectRef({
        canonicalObjectId: quotedId,
        activityPubObjectId: /^https?:\/\//.test(quotedId) ? quotedId : null,
        canonicalUrl: /^https?:\/\//.test(quotedId) ? quotedId : null,
      })
    : null;
  const inReplyTo = await resolveOptionalObjectRef(rawActivity["inReplyTo"], ctx);
  const tagFacets = await buildTagFacets(plaintext, rawActivity["tag"], ctx);
  const inlineFacets = buildInlineLinkAndTagFacets(plaintext);
  const attachments = buildAttachments(rawActivity["attachment"], objectId);
  const visibility = deriveAudience(activity.to, activity.cc);
  const provenance = toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null);

  const draft: Omit<CanonicalPostCreateIntent, "canonicalIntentId"> = {
    kind: "PostCreate",
    sourceProtocol: "activitypub",
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: activity.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility,
    provenance,
    warnings: warning
      ? [{ code: "AP_HTML_NORMALIZED", message: warning, lossiness: "minor" as const }]
      : [],
    object: objectRef,
    inReplyTo,
    quoteOf,
    content: {
      kind: "note",
      title: null,
      summary: null,
      plaintext,
      html: contentHtml,
      language: null,
      blocks,
      facets: [...tagFacets, ...inlineFacets],
      customEmojis: [],
      attachments,
      externalUrl: objectUrl !== objectId ? objectUrl : null,
      linkPreview: null,
    },
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function buildShareIntent(
  activity: ParsedActivity,
  ctx: TranslationContext,
  kind: "ShareAdd" | "ShareRemove",
  activityObject: Record<string, unknown> | null = null,
): Promise<CanonicalShareAddIntent | CanonicalShareRemoveIntent | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({
    activityPubActorUri: getActorId(activity.actor),
  });
  const targetId = extractId((activityObject ?? asObject(activity.object))?.["object"] ?? activity.object);
  if (!targetId) {
    return null;
  }

  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: targetId,
    activityPubObjectId: targetId,
    canonicalUrl: extractFirstUrl((activityObject ?? asObject(activity.object))?.["object"]) ?? targetId,
  });
  const draft = {
    sourceProtocol: "activitypub" as const,
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: activity.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: deriveAudience(activity.to, activity.cc),
    provenance: toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
  };

  if (kind === "ShareAdd") {
    const createDraft: Omit<CanonicalShareAddIntent, "canonicalIntentId"> = {
      kind,
      ...draft,
    };
    return {
      ...createDraft,
      canonicalIntentId: buildCanonicalIntentId(createDraft),
    };
  }

  const removeDraft: Omit<CanonicalShareRemoveIntent, "canonicalIntentId"> = {
    kind,
    ...draft,
  };
  return {
    ...removeDraft,
    canonicalIntentId: buildCanonicalIntentId(removeDraft),
  };
}

async function buildFollowIntent(
  activity: ParsedActivity,
  ctx: TranslationContext,
  kind: "FollowAdd" | "FollowRemove",
  activityObject: Record<string, unknown> | null = null,
): Promise<CanonicalFollowAddIntent | CanonicalFollowRemoveIntent | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({
    activityPubActorUri: getActorId(activity.actor),
  });
  const followTargetValue = (activityObject ?? asObject(activity.object))?.["object"] ?? activity.object;
  const followTargetObject = asObject(followTargetValue);
  const targetId = extractId(followTargetValue);
  if (!targetId) {
    return null;
  }

  const primaryRecipientUri = extractPrimaryFollowRecipient(activity);
  const attributedToUri = extractId(followTargetObject?.["attributedTo"]);
  const objectType = extractTypeName(followTargetObject);
  const shouldTreatAsObjectTarget =
    isFollowableObjectTarget(followTargetObject, objectType)
    || (Boolean(primaryRecipientUri) && primaryRecipientUri !== targetId);

  let subject = null;
  if (shouldTreatAsObjectTarget) {
    const subjectCandidate = attributedToUri ?? (primaryRecipientUri && primaryRecipientUri !== targetId ? primaryRecipientUri : null);
    if (subjectCandidate) {
      subject = await ctx.resolveActorRef(toActorLookupRef(subjectCandidate));
    }
  } else {
    subject = await ctx.resolveActorRef(toActorLookupRef(targetId));
  }

  const draft = {
    sourceProtocol: "activitypub" as const,
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: activity.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: deriveAudience(activity.to, activity.cc),
    provenance: toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    ...(subject ? { subject } : {}),
    ...(shouldTreatAsObjectTarget
      ? {
          targetObject: await ctx.resolveObjectRef({
            canonicalObjectId: targetId,
            activityPubObjectId: targetId,
            canonicalUrl: extractFirstUrl(followTargetValue) ?? targetId,
          }),
          activityPubRecipientUri: primaryRecipientUri ?? attributedToUri ?? targetId,
          activityPubInboxUri: extractId(followTargetObject?.["inbox"]),
          activityPubFollowersUri: extractId(followTargetObject?.["followers"]),
          recursionDepthUsed: extractFollowRecursionDepth(followTargetObject, primaryRecipientUri, targetId),
        }
      : {}),
  };

  if (kind === "FollowAdd") {
    const createDraft: Omit<CanonicalFollowAddIntent, "canonicalIntentId"> = {
      kind,
      ...draft,
    };
    return {
      ...createDraft,
      canonicalIntentId: buildCanonicalIntentId(createDraft),
    };
  }

  const removeDraft: Omit<CanonicalFollowRemoveIntent, "canonicalIntentId"> = {
    kind,
    ...draft,
  };
  return {
    ...removeDraft,
    canonicalIntentId: buildCanonicalIntentId(removeDraft),
  };
}

function toProvenance(
  bridge: ParsedActivity["bridge"],
  fallbackEventId: string,
  originAccountId: string | null,
): CanonicalProvenance {
  return {
    originProtocol: bridge?.originProtocol ?? "activitypub",
    originEventId: bridge?.originEventId ?? fallbackEventId,
    originAccountId: bridge?.originAccountId ?? originAccountId,
    mirroredFromCanonicalIntentId: bridge?.mirroredFromCanonicalIntentId ?? null,
    projectionMode: bridge?.projectionMode ?? "native",
  };
}

function getActorId(actor: ParsedActivity["actor"]): string {
  return typeof actor === "string" ? actor : actor.id;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>)["id"];
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  }
  return null;
}

function extractFirstUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = extractFirstUrl(entry);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const url = (value as Record<string, unknown>)["url"];
    return extractFirstUrl(url);
  }
  return null;
}

function extractTypeName(value: Record<string, unknown> | null): string | null {
  if (!value) {
    return null;
  }

  const rawType = value["type"] ?? value["@type"];
  if (typeof rawType === "string" && rawType.trim().length > 0) {
    return rawType.trim();
  }
  if (Array.isArray(rawType)) {
    for (const entry of rawType) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        return entry.trim();
      }
    }
  }
  return null;
}

function isFollowableObjectTarget(target: Record<string, unknown> | null, typeName: string | null): boolean {
  if (!target) {
    return false;
  }

  if (typeName && ACTOR_TYPES.has(typeName)) {
    return false;
  }

  return Boolean(extractId(target["followers"]) || extractId(target["inbox"]) || extractId(target["attributedTo"]) || typeName);
}

function extractPrimaryFollowRecipient(activity: ParsedActivity): string | null {
  for (const recipient of [...toRecipientArray(activity.to), ...toRecipientArray(activity.cc)]) {
    if (recipient === PUBLIC_AUDIENCE || recipient === "as:Public") {
      continue;
    }
    return recipient;
  }

  return null;
}

function extractFollowRecursionDepth(
  target: Record<string, unknown> | null,
  primaryRecipientUri: string | null,
  targetId: string,
): number | null {
  if (extractId(target?.["inbox"])) {
    return 0;
  }

  const attributedToUri = extractId(target?.["attributedTo"]);
  if (attributedToUri && primaryRecipientUri && primaryRecipientUri !== targetId) {
    return 1;
  }

  return null;
}

function toActorLookupRef(value: string) {
  return {
    activityPubActorUri: value.startsWith("http://") || value.startsWith("https://") ? value : null,
    did: value.startsWith("did:") ? value : null,
    webId: value.startsWith("http://") || value.startsWith("https://") ? value : null,
  };
}

function deriveAudience(rawTo: unknown, rawCc: unknown) {
  const recipients = [...toRecipientArray(rawTo), ...toRecipientArray(rawCc)];
  if (recipients.includes(PUBLIC_AUDIENCE)) {
    const publicInTo = toRecipientArray(rawTo).includes(PUBLIC_AUDIENCE);
    return publicInTo ? "public" as const : "unlisted" as const;
  }

  if (recipients.some((recipient) => recipient.includes("/followers"))) {
    return "followers" as const;
  }

  if (recipients.length > 0) {
    return "direct" as const;
  }

  return "unknown" as const;
}

function toRecipientArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
  }

  return typeof value === "string" ? [value] : [];
}
