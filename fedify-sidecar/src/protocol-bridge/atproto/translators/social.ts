import { z } from "zod";
import type {
  CanonicalFollowAddIntent,
  CanonicalFollowRemoveIntent,
  CanonicalReactionAddIntent,
  CanonicalReactionRemoveIntent,
  CanonicalShareAddIntent,
  CanonicalShareRemoveIntent,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import {
  ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
  activityPodsEmojiDefinitionSchema,
  activityPodsRecordRefSchema,
  normalizeActivityPodsReactionContent,
} from "../../../at-adapter/lexicon/ActivityPodsEmojiLexicon.js";

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

const strongRefSchema = z.object({
  uri: z.string().startsWith("at://"),
  cid: z.string().min(1),
});

const likeRecordSchema = z.object({
  $type: z.literal("app.bsky.feed.like"),
  subject: strongRefSchema,
  createdAt: z.string().optional(),
});

const repostRecordSchema = z.object({
  $type: z.literal("app.bsky.feed.repost"),
  subject: strongRefSchema,
  createdAt: z.string().optional(),
});

const followRecordSchema = z.object({
  $type: z.literal("app.bsky.graph.follow"),
  subject: z.string().startsWith("did:"),
  createdAt: z.string().optional(),
});

const emojiReactionRecordSchema = z.object({
  $type: z.literal(ACTIVITYPODS_EMOJI_REACTION_COLLECTION),
  subject: activityPodsRecordRefSchema,
  reaction: z.string().min(1),
  emoji: activityPodsEmojiDefinitionSchema.optional().nullable(),
  createdAt: z.string().optional(),
});

const baseEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  cid: z.string().optional(),
  rkey: z.string().optional(),
  collection: z.string().optional(),
  canonicalRefId: z.string().optional(),
  subjectDid: z.string().startsWith("did:").optional(),
  subjectUri: z.string().startsWith("at://").optional(),
  subjectCid: z.string().optional(),
  reactionContent: z.string().min(1).optional(),
  reactionEmoji: activityPodsEmojiDefinitionSchema.optional().nullable(),
  operation: z.enum(["create", "update", "delete"]).optional(),
  bridge: bridgeSchema,
});

const likeEnvelopeSchema = baseEnvelopeSchema.extend({
  record: likeRecordSchema,
});

const repostEnvelopeSchema = baseEnvelopeSchema.extend({
  record: repostRecordSchema,
});

const followEnvelopeSchema = baseEnvelopeSchema.extend({
  record: followRecordSchema,
});

const emojiReactionEnvelopeSchema = baseEnvelopeSchema.extend({
  record: emojiReactionRecordSchema,
});

type LikeEnvelope = z.infer<typeof likeEnvelopeSchema>;
type RepostEnvelope = z.infer<typeof repostEnvelopeSchema>;
type FollowEnvelope = z.infer<typeof followEnvelopeSchema>;
type EmojiReactionEnvelope = z.infer<typeof emojiReactionEnvelopeSchema>;
type DeleteEnvelope = z.infer<typeof baseEnvelopeSchema>;

export function supportsLikeEnvelope(input: unknown): boolean {
  return likeEnvelopeSchema.safeParse(input).success || supportsDeleteEnvelope(input, "app.bsky.feed.like");
}

export function supportsRepostEnvelope(input: unknown): boolean {
  return repostEnvelopeSchema.safeParse(input).success || supportsDeleteEnvelope(input, "app.bsky.feed.repost");
}

export function supportsFollowEnvelope(input: unknown): boolean {
  return followEnvelopeSchema.safeParse(input).success || supportsDeleteEnvelope(input, "app.bsky.graph.follow");
}

export function supportsEmojiReactionEnvelope(input: unknown): boolean {
  return emojiReactionEnvelopeSchema.safeParse(input).success
    || supportsDeleteEnvelope(input, ACTIVITYPODS_EMOJI_REACTION_COLLECTION);
}

export async function translateLikeEnvelope(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent | null> {
  const direct = likeEnvelopeSchema.safeParse(input);
  if (direct.success) {
    return buildReactionIntent(direct.data, ctx, direct.data.operation === "delete" ? "ReactionRemove" : "ReactionAdd");
  }

  const deleted = parseDeleteEnvelope(input, "app.bsky.feed.like");
  return deleted ? buildReactionDeleteIntent(deleted, ctx) : null;
}

export async function translateRepostEnvelope(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalShareAddIntent | CanonicalShareRemoveIntent | null> {
  const direct = repostEnvelopeSchema.safeParse(input);
  if (direct.success) {
    return buildShareIntent(direct.data, ctx, direct.data.operation === "delete" ? "ShareRemove" : "ShareAdd");
  }

  const deleted = parseDeleteEnvelope(input, "app.bsky.feed.repost");
  return deleted ? buildShareDeleteIntent(deleted, ctx) : null;
}

export async function translateFollowEnvelope(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalFollowAddIntent | CanonicalFollowRemoveIntent | null> {
  const direct = followEnvelopeSchema.safeParse(input);
  if (direct.success) {
    return buildFollowIntent(direct.data, ctx, direct.data.operation === "delete" ? "FollowRemove" : "FollowAdd");
  }

  const deleted = parseDeleteEnvelope(input, "app.bsky.graph.follow");
  return deleted ? buildFollowDeleteIntent(deleted, ctx) : null;
}

export async function translateEmojiReactionEnvelope(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent | null> {
  const direct = emojiReactionEnvelopeSchema.safeParse(input);
  if (direct.success) {
    return buildEmojiReactionIntent(
      direct.data,
      ctx,
      direct.data.operation === "delete" ? "ReactionRemove" : "ReactionAdd",
    );
  }

  const deleted = parseDeleteEnvelope(input, ACTIVITYPODS_EMOJI_REACTION_COLLECTION);
  return deleted ? buildEmojiReactionDeleteIntent(deleted, ctx) : null;
}

async function buildReactionIntent(
  envelope: LikeEnvelope,
  ctx: TranslationContext,
  kind: "ReactionAdd" | "ReactionRemove",
): Promise<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.record.subject.uri,
    atUri: envelope.record.subject.uri,
    cid: envelope.record.subject.cid,
    canonicalUrl: toBskyUrl(envelope.record.subject.uri),
  });
  const draft = {
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.like", envelope.rkey),
    sourceAccountRef,
    createdAt: envelope.record.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.like", envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    object: objectRef,
    reactionType: "like" as const,
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

async function buildReactionDeleteIntent(
  envelope: DeleteEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalReactionRemoveIntent | null> {
  if (!envelope.subjectUri) {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.subjectUri,
    atUri: envelope.subjectUri,
    cid: envelope.subjectCid ?? null,
    canonicalUrl: toBskyUrl(envelope.subjectUri),
  });
  const draft = {
    kind: "ReactionRemove" as const,
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.like", envelope.rkey),
    sourceAccountRef,
    createdAt: now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.like", envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    object: objectRef,
    reactionType: "like" as const,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function buildEmojiReactionIntent(
  envelope: EmojiReactionEnvelope,
  ctx: TranslationContext,
  kind: "ReactionAdd" | "ReactionRemove",
): Promise<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent | null> {
  const reactionContent = normalizeActivityPodsReactionContent(envelope.record.reaction);
  if (!reactionContent) {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.record.subject.uri,
    atUri: envelope.record.subject.uri,
    cid: envelope.record.subject.cid ?? null,
    canonicalUrl: toBskyUrl(envelope.record.subject.uri),
  });
  const draft = {
    sourceProtocol: "atproto" as const,
    sourceEventId:
      envelope.uri ?? deriveUri(envelope.repoDid, ACTIVITYPODS_EMOJI_REACTION_COLLECTION, envelope.rkey),
    sourceAccountRef,
    createdAt: envelope.record.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, ACTIVITYPODS_EMOJI_REACTION_COLLECTION, envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    object: objectRef,
    reactionType: "emoji" as const,
    reactionContent,
    reactionEmoji: envelope.record.emoji ? fromEmojiDefinition(envelope.record.emoji) : null,
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

async function buildEmojiReactionDeleteIntent(
  envelope: DeleteEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalReactionRemoveIntent | null> {
  if (!envelope.subjectUri) {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.subjectUri,
    atUri: envelope.subjectUri,
    cid: envelope.subjectCid ?? null,
    canonicalUrl: toBskyUrl(envelope.subjectUri),
  });
  const draft: Omit<CanonicalReactionRemoveIntent, "canonicalIntentId"> = {
    kind: "ReactionRemove",
    sourceProtocol: "atproto",
    sourceEventId:
      envelope.uri ?? deriveUri(envelope.repoDid, ACTIVITYPODS_EMOJI_REACTION_COLLECTION, envelope.rkey),
    sourceAccountRef,
    createdAt: now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public",
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, ACTIVITYPODS_EMOJI_REACTION_COLLECTION, envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    object: objectRef,
    reactionType: "emoji",
    reactionContent: normalizeActivityPodsReactionContent(envelope.reactionContent) ?? null,
    reactionEmoji: envelope.reactionEmoji ? fromEmojiDefinition(envelope.reactionEmoji) : null,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function buildShareIntent(
  envelope: RepostEnvelope,
  ctx: TranslationContext,
  kind: "ShareAdd" | "ShareRemove",
): Promise<CanonicalShareAddIntent | CanonicalShareRemoveIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.record.subject.uri,
    atUri: envelope.record.subject.uri,
    cid: envelope.record.subject.cid,
    canonicalUrl: toBskyUrl(envelope.record.subject.uri),
  });
  const draft = {
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.repost", envelope.rkey),
    sourceAccountRef,
    createdAt: envelope.record.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.repost", envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
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

async function buildShareDeleteIntent(
  envelope: DeleteEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalShareRemoveIntent | null> {
  if (!envelope.subjectUri) {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.subjectUri,
    atUri: envelope.subjectUri,
    cid: envelope.subjectCid ?? null,
    canonicalUrl: toBskyUrl(envelope.subjectUri),
  });
  const draft = {
    kind: "ShareRemove" as const,
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.repost", envelope.rkey),
    sourceAccountRef,
    createdAt: now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.feed.repost", envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    object: objectRef,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function buildFollowIntent(
  envelope: FollowEnvelope,
  ctx: TranslationContext,
  kind: "FollowAdd" | "FollowRemove",
): Promise<CanonicalFollowAddIntent | CanonicalFollowRemoveIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const subject = await ctx.resolveActorRef({ did: envelope.record.subject });
  const draft = {
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.graph.follow", envelope.rkey),
    sourceAccountRef,
    createdAt: envelope.record.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "direct" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.graph.follow", envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    subject,
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

async function buildFollowDeleteIntent(
  envelope: DeleteEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalFollowRemoveIntent | null> {
  if (!envelope.subjectDid) {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const subject = await ctx.resolveActorRef({ did: envelope.subjectDid });
  const draft = {
    kind: "FollowRemove" as const,
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.graph.follow", envelope.rkey),
    sourceAccountRef,
    createdAt: now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "direct" as const,
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? deriveUri(envelope.repoDid, "app.bsky.graph.follow", envelope.rkey),
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings: [],
    subject,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

function supportsDeleteEnvelope(input: unknown, collection: string): boolean {
  const parsed = baseEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    return false;
  }

  return parsed.data.operation === "delete" && parsed.data.collection === collection;
}

function parseDeleteEnvelope(input: unknown, collection: string): DeleteEnvelope | null {
  const parsed = baseEnvelopeSchema.safeParse(input);
  if (!parsed.success || parsed.data.operation !== "delete" || parsed.data.collection !== collection) {
    return null;
  }

  return parsed.data;
}

function toProvenance(
  bridge: DeleteEnvelope["bridge"],
  fallbackEventId: string,
  originAccountId: string | null,
): CanonicalProvenance {
  return {
    originProtocol: bridge?.originProtocol ?? "atproto",
    originEventId: bridge?.originEventId ?? fallbackEventId,
    originAccountId: bridge?.originAccountId ?? originAccountId,
    mirroredFromCanonicalIntentId: bridge?.mirroredFromCanonicalIntentId ?? null,
    projectionMode: bridge?.projectionMode ?? "native",
  };
}

function fromEmojiDefinition(
  emoji: EmojiReactionEnvelope["record"]["emoji"],
) {
  if (!emoji) {
    return null;
  }

  return {
    shortcode: emoji.shortcode,
    emojiId: emoji.emojiId ?? null,
    iconUrl: emoji.icon?.uri ?? null,
    mediaType: emoji.icon?.mediaType ?? null,
    updatedAt: emoji.updatedAt ?? null,
    alternateName: emoji.alternateName ?? null,
    domain: emoji.domain ?? null,
  };
}

function deriveUri(repoDid: string, collection: string, rkey?: string): string {
  return `at://${repoDid}/${collection}/${rkey ?? "unknown"}`;
}

function toBskyUrl(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}
