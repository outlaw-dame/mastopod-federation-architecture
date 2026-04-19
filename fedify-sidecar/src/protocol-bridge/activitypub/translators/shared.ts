import { z } from "zod";
import type { CanonicalAttachment, CanonicalFacet, CanonicalContentKind } from "../../canonical/CanonicalContent.js";
import type {
  CanonicalInteractionPolicy,
  CanonicalPostCreateIntent,
  CanonicalPostDeleteIntent,
  CanonicalPostEditIntent,
  CanonicalProfileUpdateIntent,
  CanonicalQuotePolicy,
  CanonicalReplyPolicy,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import { htmlToCanonicalBlocks } from "../../text/HtmlToCanonicalBlocks.js";
import { normalizeHashtag } from "../../../utils/hashtags.js";
import { fetchOpenGraph } from "../../../utils/opengraph.js";
import { collectApCustomEmojis } from "../../../utils/apCustomEmojis.js";

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

const createActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Create"),
  actor: actorSchema,
  published: z.string().optional(),
  bridge: bridgeSchema,
  object: z.record(z.string(), z.unknown()),
});

const updateActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Update"),
  actor: actorSchema,
  published: z.string().optional(),
  bridge: bridgeSchema,
  object: z.record(z.string(), z.unknown()),
});

const deleteActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Delete"),
  actor: actorSchema,
  published: z.string().optional(),
  to: z.unknown().optional(),
  cc: z.unknown().optional(),
  bridge: bridgeSchema,
  object: z.unknown(),
});

const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";
const INLINE_HASHTAG_SCAN_RE =
  /[#＃]([\p{L}\p{M}\p{N}\p{Pc}\u00B7\u30FB\u200C]+)/gu;

type ParsedCreateActivity = z.infer<typeof createActivitySchema>;
type ParsedUpdateActivity = z.infer<typeof updateActivitySchema>;
type ParsedDeleteActivity = z.infer<typeof deleteActivitySchema>;
type ParsedPostActivity = Pick<ParsedCreateActivity, "id" | "actor" | "published" | "bridge" | "object">;

export function supportsCreateActivity(input: unknown, objectType: "Note" | "Article"): boolean {
  const parsed = createActivitySchema.safeParse(input);
  if (!parsed.success) {
    return false;
  }

  return getObjectType(parsed.data.object) === objectType;
}

export async function translateCreateActivity(
  input: unknown,
  ctx: TranslationContext,
  objectType: "Note" | "Article",
): Promise<CanonicalPostCreateIntent | null> {
  const parsed = createActivitySchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  if (getObjectType(parsed.data.object) !== objectType) {
    return null;
  }

  return buildCanonicalPostIntent(parsed.data, ctx, objectType === "Article" ? "article" : "note");
}

export function supportsUpdateActivity(input: unknown, objectType: "Note" | "Article"): boolean {
  const parsed = updateActivitySchema.safeParse(input);
  if (!parsed.success) {
    return false;
  }

  return getObjectType(parsed.data.object) === objectType;
}

export async function translateUpdateActivity(
  input: unknown,
  ctx: TranslationContext,
  objectType: "Note" | "Article",
): Promise<CanonicalPostEditIntent | null> {
  const parsed = updateActivitySchema.safeParse(input);
  if (!parsed.success || getObjectType(parsed.data.object) !== objectType) {
    return null;
  }

  return buildCanonicalPostEditIntent(parsed.data, ctx, objectType === "Article" ? "article" : "note");
}

export function supportsDeleteActivity(input: unknown): boolean {
  const parsed = deleteActivitySchema.safeParse(input);
  if (!parsed.success) {
    return false;
  }

  const objectType = getObjectType(asObject(parsed.data.object));
  return !objectType || objectType === "Note" || objectType === "Article";
}

export async function translateDeleteActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalPostDeleteIntent | null> {
  const parsed = deleteActivitySchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  const object = asObject(parsed.data.object);
  const objectType = getObjectType(object);
  if (objectType && objectType !== "Note" && objectType !== "Article") {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(parsed.data.actor);
  const targetId = extractId(parsed.data.object) ?? extractFirstUrl(parsed.data.object);
  if (!targetId) {
    return null;
  }

  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: targetId,
    activityPubObjectId: /^https?:\/\//.test(targetId) ? targetId : null,
    canonicalUrl: extractFirstUrl(object?.["url"]) ?? (/^https?:\/\//.test(targetId) ? targetId : null),
  });

  const draft: Omit<CanonicalPostDeleteIntent, "canonicalIntentId"> = {
    kind: "PostDelete",
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

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

export function supportsProfileUpdateActivity(input: unknown): boolean {
  const parsed = updateActivitySchema.safeParse(input);
  return parsed.success && getObjectType(parsed.data.object) === "Person";
}

export async function translateProfileUpdateActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalProfileUpdateIntent | null> {
  const parsed = updateActivitySchema.safeParse(input);
  if (!parsed.success || getObjectType(parsed.data.object) !== "Person") {
    return null;
  }

  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(parsed.data.actor);
  const summaryHtml = asString(parsed.data.object["summary"]) ?? "";
  const { plaintext, blocks, warning } = htmlToCanonicalBlocks(summaryHtml);
  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const tagFacets = await buildTagFacets(plaintext, parsed.data.object["tag"], ctx);
  const customEmojis = collectApCustomEmojis(parsed.data.object["tag"], {
    referencedText: [summaryHtml, asString(parsed.data.object["name"])],
    fallbackDomain: actorId,
  });
  const inlineFacets = buildInlineLinkAndTagFacets(plaintext);
  const attachments = [
    ...buildAttachments(parsed.data.object["icon"], `${actorId}:icon`)
      .map((attachment) => ({ ...attachment, role: "avatar" as const })),
    ...buildAttachments(parsed.data.object["image"], `${actorId}:image`)
      .map((attachment) => ({ ...attachment, role: "banner" as const })),
  ];
  const draft: Omit<CanonicalProfileUpdateIntent, "canonicalIntentId"> = {
    kind: "ProfileUpdate",
    sourceProtocol: "activitypub",
    sourceEventId: parsed.data.id,
    sourceAccountRef,
    createdAt:
      asString(parsed.data.object["updated"])
      ?? parsed.data.published
      ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: deriveAudience(parsed.data.object["to"], parsed.data.object["cc"]),
    provenance: toProvenance(parsed.data.bridge, parsed.data.id, sourceAccountRef.canonicalAccountId ?? null),
    warnings: warning
      ? [{ code: "AP_HTML_NORMALIZED", message: warning, lossiness: "minor" }]
      : [],
    content: {
      kind: "profile",
      title: asString(parsed.data.object["name"]) ?? null,
      summary: null,
      plaintext,
      html: summaryHtml || null,
      language: null,
      blocks,
      facets: mergeFacets(tagFacets, inlineFacets),
      customEmojis,
      attachments,
      externalUrl: extractFirstUrl(parsed.data.object["url"]) ?? actorId,
    },
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function buildCanonicalPostIntent(
  activity: ParsedPostActivity,
  ctx: TranslationContext,
  contentKind: CanonicalContentKind,
): Promise<CanonicalPostCreateIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(activity.actor);
  const objectId = asString(activity.object["id"]) ?? activity.id;
  const objectUrl = extractFirstUrl(activity.object["url"]) ?? objectId;
  const objectContent = asString(activity.object["content"]) ?? "";
  const objectPublished = asString(activity.object["published"]) ?? activity.published ?? now.toISOString();
  const objectSummary = asString(activity.object["summary"]);
  const objectTitle = asString(activity.object["name"]);
  const { plaintext, blocks, warning } = htmlToCanonicalBlocks(objectContent);
  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: objectId,
    activityPubObjectId: objectId,
    canonicalUrl: objectUrl,
  });
  const inReplyTo = await resolveOptionalObjectRef(activity.object["inReplyTo"], ctx);
  const quoteOf = await resolveOptionalQuoteRef(activity.object, ctx);
  const interactionPolicy = parseApInteractionPolicy(activity.object, actorId);
  const tagFacets = await buildTagFacets(plaintext, activity.object["tag"], ctx);
  const customEmojis = collectApCustomEmojis(activity.object["tag"], {
    referencedText: [objectContent, objectSummary, objectTitle],
    fallbackDomain: objectId,
  });
  const inlineFacets = buildInlineLinkAndTagFacets(plaintext);
  const attachments = buildAttachments(activity.object["attachment"], objectId);
  const visibility = deriveAudience(activity.object["to"], activity.object["cc"]);
  const provenance = toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null);
  const mergedFacets = mergeFacets(tagFacets, inlineFacets);
  const linkPreview = await resolvePrimaryLinkPreview(contentKind, objectUrl, mergedFacets);

  const draft: Omit<CanonicalPostCreateIntent, "canonicalIntentId"> = {
    kind: "PostCreate",
    sourceProtocol: "activitypub",
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: objectPublished,
    observedAt: now.toISOString(),
    visibility,
    provenance,
    warnings: warning
      ? [{ code: "AP_HTML_NORMALIZED", message: warning, lossiness: "minor" }]
      : [],
    object: objectRef,
    inReplyTo,
    quoteOf,
    interactionPolicy,
    content: {
      kind: contentKind,
      title: objectTitle ?? null,
      summary: objectSummary ?? null,
      plaintext,
      html: objectContent || null,
      language: asString(activity.object["contentMapLang"]) ?? null,
      blocks,
      facets: mergedFacets,
      customEmojis,
      attachments,
      externalUrl: objectUrl,
      linkPreview,
    },
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function buildCanonicalPostEditIntent(
  activity: ParsedUpdateActivity,
  ctx: TranslationContext,
  contentKind: CanonicalContentKind,
): Promise<CanonicalPostEditIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(activity.actor);
  const objectId = asString(activity.object["id"]) ?? activity.id;
  const objectUrl = extractFirstUrl(activity.object["url"]) ?? objectId;
  const objectContent = asString(activity.object["content"]) ?? "";
  const objectUpdated =
    asString(activity.object["updated"])
    ?? asString(activity.object["published"])
    ?? activity.published
    ?? now.toISOString();
  const objectSummary = asString(activity.object["summary"]);
  const objectTitle = asString(activity.object["name"]);
  const { plaintext, blocks, warning } = htmlToCanonicalBlocks(objectContent);
  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: objectId,
    activityPubObjectId: objectId,
    canonicalUrl: objectUrl,
  });
  const inReplyTo = await resolveOptionalObjectRef(activity.object["inReplyTo"], ctx);
  const quoteOf = await resolveOptionalQuoteRef(activity.object, ctx);
  const interactionPolicy = parseApInteractionPolicy(activity.object, actorId);
  const tagFacets = await buildTagFacets(plaintext, activity.object["tag"], ctx);
  const customEmojis = collectApCustomEmojis(activity.object["tag"], {
    referencedText: [objectContent, objectSummary, objectTitle],
    fallbackDomain: objectId,
  });
  const inlineFacets = buildInlineLinkAndTagFacets(plaintext);
  const attachments = buildAttachments(activity.object["attachment"], objectId);
  const visibility = deriveAudience(activity.object["to"], activity.object["cc"]);
  const provenance = toProvenance(activity.bridge, activity.id, sourceAccountRef.canonicalAccountId ?? null);
  const mergedFacets = mergeFacets(tagFacets, inlineFacets);
  const linkPreview = await resolvePrimaryLinkPreview(contentKind, objectUrl, mergedFacets);

  const draft: Omit<CanonicalPostEditIntent, "canonicalIntentId"> = {
    kind: "PostEdit",
    sourceProtocol: "activitypub",
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: objectUpdated,
    observedAt: now.toISOString(),
    visibility,
    provenance,
    warnings: warning
      ? [{ code: "AP_HTML_NORMALIZED", message: warning, lossiness: "minor" }]
      : [],
    object: objectRef,
    inReplyTo,
    quoteOf,
    interactionPolicy,
    content: {
      kind: contentKind,
      title: objectTitle ?? null,
      summary: objectSummary ?? null,
      plaintext,
      html: objectContent || null,
      language: asString(activity.object["contentMapLang"]) ?? null,
      blocks,
      facets: mergedFacets,
      customEmojis,
      attachments,
      externalUrl: objectUrl,
      linkPreview,
    },
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

export function toProvenance(
  bridge: ParsedCreateActivity["bridge"] | ParsedUpdateActivity["bridge"] | ParsedDeleteActivity["bridge"],
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

async function resolvePrimaryLinkPreview(
  contentKind: CanonicalContentKind,
  objectUrl: string | null | undefined,
  facets: readonly CanonicalFacet[],
) {
  const previewUrl = resolvePrimaryLinkPreviewUrl(contentKind, objectUrl, facets);
  if (!previewUrl) {
    return null;
  }

  const ogData = await fetchOpenGraph(previewUrl);
  if (!ogData) {
    return null;
  }

  return {
    uri: ogData.uri,
    title: ogData.title,
    description: ogData.description ?? null,
    thumbUrl: ogData.thumbUrl ?? null,
  };
}

function resolvePrimaryLinkPreviewUrl(
  contentKind: CanonicalContentKind,
  objectUrl: string | null | undefined,
  facets: readonly CanonicalFacet[],
): string | null {
  if (contentKind === "article") {
    return objectUrl ?? null;
  }
  if (contentKind !== "note") {
    return null;
  }

  const firstLinkFacet = facets.find((facet) => facet.type === "link");
  return firstLinkFacet?.url ?? null;
}

// ---------------------------------------------------------------------------
// AP interaction policy parsing (GoToSocial `interactionPolicy` vocabulary)
// ---------------------------------------------------------------------------

/**
 * Parse an ActivityPub `interactionPolicy` object (GoToSocial vocabulary) into
 * a `CanonicalInteractionPolicy`.  Returns `null` when the object is absent or
 * when both fields resolve to their defaults ("everyone"), so callers can
 * treat a null result as "no non-default policy".
 *
 * Reading rules:
 *   canReply:
 *     automaticApproval = PUBLIC_AUDIENCE                → "everyone" (default)
 *     automaticApproval = any followers URI              → "followers"
 *     automaticApproval = other IRI                     → "mentioned"
 *     automaticApproval absent (incl. empty object)     → "nobody"
 *   canQuote:
 *     automaticApproval = PUBLIC_AUDIENCE                → "everyone" (default)
 *     automaticApproval absent (incl. empty object)     → "nobody"
 */
export function parseApInteractionPolicy(
  activityObject: Record<string, unknown>,
  actorId: string,
): CanonicalInteractionPolicy | null {
  const rawPolicy = asObject(activityObject["interactionPolicy"]);
  if (!rawPolicy) {
    return null;
  }

  const canReply = parseReplyPolicy(asObject(rawPolicy["canReply"]), actorId);
  const canQuote = parseQuotePolicy(asObject(rawPolicy["canQuote"]));

  // Return null when both are defaults to avoid storing no-op policy objects.
  if (canReply === "everyone" && canQuote === "everyone") {
    return null;
  }

  return { canReply, canQuote };
}

function parseReplyPolicy(
  raw: Record<string, unknown> | null,
  actorId: string,
): CanonicalReplyPolicy {
  if (!raw) {
    return "everyone"; // absent interactionPolicy → default
  }

  const autoApproval = extractFirstIri(raw["automaticApproval"]);
  if (!autoApproval) {
    return "nobody"; // present but no automaticApproval → nobody allowed automatically
  }

  if (autoApproval === PUBLIC_AUDIENCE) {
    return "everyone";
  }

  // Followers URI: either the well-known pattern or the actor's own followers collection.
  const followersUri = `${actorId}/followers`;
  if (autoApproval === followersUri || autoApproval.endsWith("/followers")) {
    return "followers";
  }

  // A non-public, non-followers IRI is best interpreted as a specific audience
  // (e.g. a list or "mentioned users" substitute).
  return "mentioned";
}

function parseQuotePolicy(
  raw: Record<string, unknown> | null,
): CanonicalQuotePolicy {
  if (!raw) {
    return "everyone"; // absent interactionPolicy → default
  }

  const autoApproval = extractFirstIri(raw["automaticApproval"]);
  if (!autoApproval) {
    return "nobody"; // present but no automaticApproval → quoting disabled
  }

  if (autoApproval === PUBLIC_AUDIENCE) {
    return "everyone";
  }

  // Any non-public automaticApproval on canQuote is treated as restricted.
  return "nobody";
}

/**
 * Extract the first IRI string from an ActivityPub audience value.
 * Accepts a plain string, an array of strings, or a `{id: string}` object.
 */
function extractFirstIri(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const iri = extractFirstIri(entry);
      if (iri) {
        return iri;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>)["id"];
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  }

  return null;
}

export async function resolveOptionalObjectRef(
  rawValue: unknown,
  ctx: TranslationContext,
) {
  const objectId = extractId(rawValue);
  if (!objectId) {
    return null;
  }

  return ctx.resolveObjectRef({
    canonicalObjectId: objectId,
    activityPubObjectId: objectId,
    canonicalUrl: objectId,
  });
}

async function resolveOptionalQuoteRef(
  activityObject: Record<string, unknown>,
  ctx: TranslationContext,
) {
  // FEP-044f primary term first, then backwards-compat aliases
  const rawQuote = activityObject["quote"]
    ?? activityObject["quoteUrl"]
    ?? activityObject["quoteUri"]
    ?? activityObject["quoteURI"];
  const quoteId = sanitizeQuoteReferenceId(extractId(rawQuote) ?? extractFirstUrl(rawQuote));
  if (!quoteId) {
    return null;
  }

  const quoteCanonicalUrl = sanitizeAttachmentUrl(extractFirstUrl(rawQuote));

  return ctx.resolveObjectRef({
    canonicalObjectId: quoteId,
    activityPubObjectId: /^https?:\/\//.test(quoteId) ? quoteId : null,
    canonicalUrl: quoteCanonicalUrl ?? (/^https?:\/\//.test(quoteId) ? quoteId : null),
  });
}

export async function buildTagFacets(
  text: string,
  rawTags: unknown,
  ctx: TranslationContext,
): Promise<CanonicalFacet[]> {
  const tags = Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [];
  const facets: CanonicalFacet[] = [];

  for (const rawTag of tags) {
    if (!rawTag || typeof rawTag !== "object") {
      continue;
    }

    const tag = rawTag as Record<string, unknown>;
    const tagType = typeof tag["type"] === "string" ? tag["type"] : "";
    const name = typeof tag["name"] === "string" ? tag["name"].trim() : "";
    const href = extractFirstUrl(tag["href"]);
    if (!name) {
      continue;
    }

    const [start, end] = findRange(text, name);
    if (start === -1) {
      continue;
    }

    if (tagType === "Mention" && href) {
      facets.push({
        type: "mention",
        label: name,
        target: await ctx.resolveActorRef({ activityPubActorUri: href }),
        start,
        end,
      });
      continue;
    }

    if (tagType === "Hashtag") {
      const normalizedTag = normalizeHashtag(name);
      if (!normalizedTag) {
        continue;
      }

      facets.push({
        type: "tag",
        tag: normalizedTag,
        start,
        end,
      });
    }
  }

  return facets;
}

export function buildInlineLinkAndTagFacets(text: string): CanonicalFacet[] {
  const facets: CanonicalFacet[] = [];
  const seen = new Set<string>();
  const urlRanges: Array<{ start: number; end: number }> = [];

  for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const url = match[0];
    const start = match.index ?? -1;
    const end = start + url.length;
    if (start >= 0) {
      urlRanges.push({ start, end });
      const key = `link:${start}:${end}:${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        facets.push({ type: "link", url, start, end });
      }
    }
  }

  for (const match of text.matchAll(INLINE_HASHTAG_SCAN_RE)) {
    const tag = match[1];
    if (!tag) {
      continue;
    }

    const whole = match[0];
    const rawHashtag = whole;
    const normalizedTag = normalizeHashtag(rawHashtag, { allowMissingHash: true });
    if (!normalizedTag) {
      continue;
    }

    const baseIndex = match.index ?? -1;
    const start = baseIndex;
    const end = start + rawHashtag.length;
    if (urlRanges.some((range) => start >= range.start && start < range.end)) {
      continue;
    }
    if (start >= 0) {
      const key = `tag:${start}:${end}:${normalizedTag}`;
      if (!seen.has(key)) {
        seen.add(key);
        facets.push({
          type: "tag",
          tag: normalizedTag,
          start,
          end,
        });
      }
    }
  }

  return facets;
}

export function buildAttachments(rawAttachments: unknown, objectId: string): CanonicalAttachment[] {
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : rawAttachments ? [rawAttachments] : [];

  return attachments
    .map((attachment, index) => toAttachment(attachment, `${objectId}:attachment:${index}`))
    .filter((attachment): attachment is CanonicalAttachment => attachment !== null);
}

function toAttachment(rawAttachment: unknown, fallbackId: string): CanonicalAttachment | null {
  if (typeof rawAttachment === "string") {
    const sanitizedUrl = sanitizeAttachmentUrl(rawAttachment);
    if (!sanitizedUrl) {
      return null;
    }

    return {
      attachmentId: fallbackId,
      mediaType: "application/octet-stream",
      url: sanitizedUrl,
    };
  }

  if (!rawAttachment || typeof rawAttachment !== "object") {
    return null;
  }

  const attachment = rawAttachment as Record<string, unknown>;
  const { primaryUrl, cid: urlCid } = extractHttpUrlAndCid(attachment["url"]);
  const url = sanitizeAttachmentUrl(primaryUrl);
  const id = asString(attachment["id"]) ?? url ?? fallbackId;
  const mediaType = asString(attachment["mediaType"]) ?? inferMediaType(asString(attachment["type"]));

  if (!url && !id) {
    return null;
  }

  return {
    attachmentId: id,
    mediaType,
    url,
    cid: asString(attachment["cid"]) ?? urlCid ?? null,
    alt: asString(attachment["name"]) ?? asString(attachment["summary"]) ?? null,
    byteSize: asAttachmentByteSize(attachment),
    width: asOptionalNumber(attachment["width"]),
    height: asOptionalNumber(attachment["height"]),
    duration: asOptionalScalar(attachment["duration"]),
    digestMultibase: asString(attachment["digestMultibase"]) ?? sha256HexToDigestMultibase(asString(attachment["sha256"])),
    focalPoint: asFocalPoint(attachment["focalPoint"]),
    blurhash: asString(attachment["blurhash"]) ?? asString(attachment["blurHash"]) ?? null,
  };
}

function sanitizeAttachmentUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol === "ipfs:") {
    return parsed.toString();
  }

  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) {
    return parsed.toString();
  }

  return null;
}

function sanitizeQuoteReferenceId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (/^at:\/\//.test(value)) {
    return value;
  }

  if (/^urn:/.test(value)) {
    return value;
  }

  return sanitizeAttachmentUrl(value);
}

function inferMediaType(type: string | null): string {
  switch (type) {
    case "Image":
      return "image/*";
    case "Video":
      return "video/*";
    case "Audio":
      return "audio/*";
    default:
      return "application/octet-stream";
  }
}

export function deriveAudience(rawTo: unknown, rawCc: unknown) {
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

export function getActorId(actor: ParsedCreateActivity["actor"]): string {
  return typeof actor === "string" ? actor : actor.id;
}

export function getObjectType(object: ParsedCreateActivity["object"] | Record<string, unknown> | null): string | null {
  if (!object) {
    return null;
  }
  return typeof object["type"] === "string" ? object["type"] : null;
}

export function extractFirstUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractFirstUrl(entry);
      if (url) {
        return url;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const href = (value as Record<string, unknown>)["href"];
    return typeof href === "string" ? href : null;
  }
  return null;
}

/**
 * Collect all URL strings from an ActivityPub `url` value (string, array, or Link object).
 * Prefers the first non-ipfs:// HTTP(S) URL as the primary canonical URL.
 * If an ipfs:// URL is present, extracts the CID for content-addressed storage.
 */
export function extractHttpUrlAndCid(value: unknown): { primaryUrl: string | null; cid: string | null } {
  const all = collectAllUrls(value);

  const httpUrl = all.find((u) => /^https?:\/\//i.test(u)) ?? null;
  const ipfsUrl = all.find((u) => /^ipfs:\/\//i.test(u)) ?? null;

  let cid: string | null = null;
  if (ipfsUrl) {
    const stripped = ipfsUrl.replace(/^ipfs:\/\//i, "").trim();
    if (stripped.length > 0) {
      cid = stripped;
    }
  }

  return { primaryUrl: httpUrl ?? (all[0] ?? null), cid };
}

function collectAllUrls(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectAllUrls(entry));
  }
  if (value && typeof value === "object") {
    const href = (value as Record<string, unknown>)["href"];
    return typeof href === "string" && href.trim().length > 0 ? [href] : [];
  }
  return [];
}

export function extractId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>)["id"];
    return typeof id === "string" ? id : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asAttachmentByteSize(value: Record<string, unknown>): number | null {
  return asOptionalNumber(value["size"]) ?? asOptionalNumber(value["byteSize"]);
}

function asOptionalScalar(value: unknown): string | number | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return asOptionalNumber(value);
}

function asFocalPoint(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = asOptionalNumber(value[0]);
    const y = asOptionalNumber(value[1]);
    return x != null && y != null ? [x, y] : null;
  }

  const object = asObject(value);
  if (!object) {
    return null;
  }

  const x = asOptionalNumber(object["x"]);
  const y = asOptionalNumber(object["y"]);
  return x != null && y != null ? [x, y] : null;
}

function sha256HexToDigestMultibase(value: string | null): string | null {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    return null;
  }

  return `u${Buffer.from(value, "hex").toString("base64url")}`;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findRange(text: string, value: string): [number, number] {
  const index = text.indexOf(value);
  return index >= 0 ? [index, index + value.length] : [-1, -1];
}

function mergeFacets(primary: CanonicalFacet[], secondary: CanonicalFacet[]): CanonicalFacet[] {
  const merged = [...primary];
  const seen = new Set(primary.map((facet) => facetKey(facet)));

  for (const facet of secondary) {
    const key = facetKey(facet);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(facet);
    }
  }

  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}

function facetKey(facet: CanonicalFacet): string {
  switch (facet.type) {
    case "mention":
      return `${facet.type}:${facet.start}:${facet.end}:${facet.label}:${facet.target.did ?? facet.target.activityPubActorUri ?? ""}`;
    case "tag":
      return `${facet.type}:${facet.start}:${facet.end}:${facet.tag}`;
    case "link":
      return `${facet.type}:${facet.start}:${facet.end}:${facet.url}`;
  }
}
