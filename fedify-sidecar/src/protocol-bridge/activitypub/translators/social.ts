import { z } from "zod";
import type {
  CanonicalFollowAddIntent,
  CanonicalFollowRemoveIntent,
  CanonicalIntent,
  CanonicalReactionAddIntent,
  CanonicalReactionRemoveIntent,
  CanonicalShareAddIntent,
  CanonicalShareRemoveIntent,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";

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

export function supportsSocialActivity(input: unknown, type: "Like" | "Announce" | "Follow" | "Undo"): boolean {
  const parsed = baseActivitySchema.safeParse(input);
  return parsed.success && parsed.data.type === type;
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
      return buildReactionIntent(parsed.data, ctx, "ReactionRemove", object);
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
  const subjectId = extractId((activityObject ?? asObject(activity.object))?.["object"] ?? activity.object);
  if (!subjectId) {
    return null;
  }

  const subject = await ctx.resolveActorRef({
    activityPubActorUri: subjectId.startsWith("http://") || subjectId.startsWith("https://") ? subjectId : null,
    did: subjectId.startsWith("did:") ? subjectId : null,
    webId: subjectId.startsWith("http://") || subjectId.startsWith("https://") ? subjectId : null,
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
