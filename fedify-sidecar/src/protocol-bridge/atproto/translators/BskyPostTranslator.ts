import { z } from "zod";
import type { CanonicalIntent, CanonicalPostCreateIntent, CanonicalPostEditIntent } from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { createParagraphBlocks } from "../../canonical/CanonicalContent.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { atFacetsToCanonicalFacets } from "../../text/AtFacetsToCanonicalText.js";
import { htmlToCanonicalBlocks } from "../../text/HtmlToCanonicalBlocks.js";
import { looksLikeMarkdown, renderMarkdownToHtml } from "../../../utils/markdown.js";
import { fetchOpenGraph } from "../../../utils/opengraph.js";

const replySchema = z.object({
  root: z.object({
    uri: z.string().startsWith("at://"),
    cid: z.string().optional(),
  }).optional(),
  parent: z.object({
    uri: z.string().startsWith("at://"),
    cid: z.string().optional(),
  }),
});

const recordSchema = z.object({
  $type: z.literal("app.bsky.feed.post"),
  text: z.string().max(3000),
  createdAt: z.string().optional(),
  langs: z.array(z.string()).optional(),
  facets: z.array(z.unknown()).optional(),
  reply: replySchema.optional(),
  embed: z.unknown().optional(),
});

const directEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  cid: z.string().optional(),
  rkey: z.string().optional(),
  canonicalRefId: z.string().optional(),
  operation: z.enum(["create", "update"]).optional(),
  bridge: z.object({
    originProtocol: z.enum(["activitypub", "atproto"]),
    originEventId: z.string().min(1),
    originAccountId: z.string().optional(),
    mirroredFromCanonicalIntentId: z.string().optional().nullable(),
    projectionMode: z.enum(["native", "mirrored"]).optional(),
  }).optional(),
  record: recordSchema,
});

const ingressEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  eventType: z.literal("#commit"),
  did: z.string().startsWith("did:"),
  source: z.string().optional(),
  verifiedAt: z.string().optional(),
  bridge: z.object({
    originProtocol: z.enum(["activitypub", "atproto"]),
    originEventId: z.string().min(1),
    originAccountId: z.string().optional(),
    mirroredFromCanonicalIntentId: z.string().optional().nullable(),
    projectionMode: z.enum(["native", "mirrored"]).optional(),
  }).optional(),
  commit: z.object({
    operation: z.enum(["create", "update"]),
    collection: z.literal("app.bsky.feed.post"),
    rkey: z.string(),
    cid: z.string().nullable().optional(),
    canonicalRefId: z.string().optional(),
    record: recordSchema.nullable().optional(),
  }),
});

type DirectEnvelope = z.infer<typeof directEnvelopeSchema>;
type IngressEnvelope = z.infer<typeof ingressEnvelopeSchema>;

export class BskyPostTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return directEnvelopeSchema.safeParse(input).success || ingressEnvelopeSchema.safeParse(input).success;
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    const direct = directEnvelopeSchema.safeParse(input);
    if (direct.success) {
      return translateDirectEnvelope(direct.data, ctx);
    }

    const ingress = ingressEnvelopeSchema.safeParse(input);
    if (ingress.success) {
      return translateIngressEnvelope(ingress.data, ctx);
    }

    return null;
  }
}

async function translateDirectEnvelope(
  envelope: DirectEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalPostCreateIntent | CanonicalPostEditIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectUri = envelope.uri ?? `at://${envelope.repoDid}/app.bsky.feed.post/${envelope.rkey ?? envelope.cid ?? "unknown"}`;
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.canonicalRefId ?? objectUri,
    atUri: objectUri,
    cid: envelope.cid ?? null,
    canonicalUrl: toBskyUrl(envelope.repoDid, envelope.rkey),
  });
  const facets = await atFacetsToCanonicalFacets(
    envelope.record.text,
    envelope.record.facets ?? [],
    async (did) => ctx.resolveActorRef({ did }),
  );
  const inReplyTo = envelope.record.reply?.parent
    ? await ctx.resolveObjectRef({
        canonicalObjectId: envelope.record.reply.parent.uri,
        atUri: envelope.record.reply.parent.uri,
        cid: envelope.record.reply.parent.cid ?? null,
      })
    : null;
  const quoteOf = await resolveQuoteRef(envelope.record.embed, ctx);
  const attachments = await parseEmbedAttachments(
    envelope.record.embed,
    envelope.repoDid,
    objectUri,
    ctx,
  );

  // Markdown rendering (no MFM) — only when text contains Markdown syntax.
  const rawText = envelope.record.text;
  const renderedHtml = looksLikeMarkdown(rawText)
    ? renderMarkdownToHtml(rawText)
    : null;
  const { blocks } = renderedHtml
    ? htmlToCanonicalBlocks(renderedHtml)
    : { blocks: createParagraphBlocks(rawText) };

  // OpenGraph live preview — fetch from the first link facet URL.
  const firstLinkUrl =
    (facets.find((f) => f.type === "link") as { url: string } | undefined)?.url ?? null;
  const ogData = firstLinkUrl ? await fetchOpenGraph(firstLinkUrl) : null;
  const linkPreview = ogData
    ? {
        uri: ogData.uri,
        title: ogData.title,
        description: ogData.description ?? null,
        thumbUrl: ogData.thumbUrl ?? null,
      }
    : null;

  const provenance = toProvenance(
    envelope.bridge,
    envelope.uri ?? objectUri,
    sourceAccountRef.canonicalAccountId ?? null,
  );
  const baseDraft = {
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? objectUri,
    sourceAccountRef,
    createdAt: envelope.record.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance,
    warnings: [],
    object: objectRef,
    inReplyTo,
    quoteOf,
    content: {
      kind: "note" as const,
      title: null,
      summary: null,
      plaintext: envelope.record.text,
      html: renderedHtml,
      language: envelope.record.langs?.[0] ?? null,
      blocks,
      facets,
      attachments,
      externalUrl: null,
      linkPreview,
    },
  };

  if (envelope.operation === "update") {
    const draft: Omit<CanonicalPostEditIntent, "canonicalIntentId"> = {
      kind: "PostEdit",
      ...baseDraft,
    };
    return {
      ...draft,
      canonicalIntentId: buildCanonicalIntentId(draft),
    };
  }

  const draft: Omit<CanonicalPostCreateIntent, "canonicalIntentId"> = {
    kind: "PostCreate",
    ...baseDraft,
  };
  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function resolveQuoteRef(
  embed: unknown,
  ctx: TranslationContext,
) {
  const strongRef = extractQuotedRecordStrongRef(embed);
  if (!strongRef) {
    return null;
  }

  return ctx.resolveObjectRef({
    canonicalObjectId: strongRef.uri,
    atUri: strongRef.uri,
    cid: strongRef.cid ?? null,
    canonicalUrl: toBskyUrlFromAtUri(strongRef.uri),
  });
}

function extractQuotedRecordStrongRef(embed: unknown): { uri: string; cid: string | null } | null {
  const obj = toPlainObject(embed);
  if (!obj) {
    return null;
  }

  const type = typeof obj["$type"] === "string" ? obj["$type"] : "";
  if (type === "app.bsky.embed.record") {
    return parseRecordStrongRef(obj["record"]);
  }

  if (type === "app.bsky.embed.recordWithMedia") {
    return parseRecordStrongRef(obj["record"]);
  }

  return null;
}

function parseRecordStrongRef(value: unknown): { uri: string; cid: string | null } | null {
  const ref = toPlainObject(value);
  if (!ref) {
    return null;
  }

  const uri = typeof ref["uri"] === "string" ? ref["uri"].trim() : "";
  if (!uri.startsWith("at://")) {
    return null;
  }

  const cid = typeof ref["cid"] === "string" && ref["cid"].trim().length > 0
    ? ref["cid"].trim()
    : null;

  return { uri, cid };
}

function toBskyUrlFromAtUri(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) {
    return null;
  }

  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}

async function translateIngressEnvelope(
  envelope: IngressEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  if (!envelope.commit.record) {
    return null;
  }

  return translateDirectEnvelope(
    {
      repoDid: envelope.did,
      uri: `at://${envelope.did}/${envelope.commit.collection}/${envelope.commit.rkey}`,
      cid: envelope.commit.cid ?? undefined,
      rkey: envelope.commit.rkey,
      canonicalRefId: envelope.commit.canonicalRefId,
      operation: envelope.commit.operation,
      bridge: envelope.bridge,
      record: envelope.commit.record,
    },
    ctx,
  );
}

function toProvenance(
  bridge: DirectEnvelope["bridge"] | IngressEnvelope["bridge"],
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

function toBskyUrl(did: string, rkey?: string): string | null {
  return rkey ? `https://bsky.app/profile/${did}/post/${rkey}` : null;
}

async function parseEmbedAttachments(
  embed: unknown,
  repoDid: string,
  objectUri: string,
  ctx: TranslationContext,
): Promise<CanonicalPostCreateIntent["content"]["attachments"]> {
  const mediaEmbeds = collectMediaEmbeds(embed);
  const attachments = await Promise.all(
    mediaEmbeds.map(async (entry, index) => {
      const blob = entry.blob;
      const cid = extractCid(blob);
      const mediaType = typeof blob?.["mimeType"] === "string"
        ? blob["mimeType"].trim()
        : entry.defaultMediaType;
      const byteSize = typeof blob?.["size"] === "number" && Number.isFinite(blob["size"])
        ? Math.max(0, Math.floor(blob["size"]))
        : null;
      const url = cid && ctx.resolveBlobUrl ? await ctx.resolveBlobUrl(repoDid, cid) : null;
      const aspectRatio = entry.aspectRatio;
      const width = toPositiveInteger(aspectRatio?.["width"]);
      const height = toPositiveInteger(aspectRatio?.["height"]);
      const alt = normalizeAlt(entry.alt);

      return {
        attachmentId: `${objectUri}#attachment-${index + 1}`,
        mediaType,
        ...(url ? { url } : {}),
        ...(cid ? { cid } : {}),
        ...(byteSize != null ? { byteSize } : {}),
        ...(alt ? { alt } : {}),
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
      };
    }),
  );

  return attachments;
}

function collectMediaEmbeds(embed: unknown): Array<{
  blob: Record<string, unknown> | null;
  defaultMediaType: string;
  alt: unknown;
  aspectRatio: Record<string, unknown> | null;
}> {
  const obj = toPlainObject(embed);
  if (!obj) {
    return [];
  }

  const type = typeof obj["$type"] === "string" ? obj["$type"] : "";
  if (type === "app.bsky.embed.images") {
    return toObjectArray(obj["images"]).map((entry) => ({
      blob: toPlainObject(entry["image"]),
      defaultMediaType: "image/*",
      alt: entry["alt"],
      aspectRatio: toPlainObject(entry["aspectRatio"]),
    }));
  }

  if (type === "app.bsky.embed.video") {
    return [
      {
        blob: toPlainObject(obj["video"]),
        defaultMediaType: "video/*",
        alt: obj["alt"],
        aspectRatio: toPlainObject(obj["aspectRatio"]),
      },
    ];
  }

  if (type === "app.bsky.embed.recordWithMedia") {
    const media = toPlainObject(obj["media"]);
    if (media) {
      return collectMediaEmbeds(media);
    }
  }

  return [];
}

function toObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => Boolean(toPlainObject(entry)));
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractCid(blob: Record<string, unknown> | null): string | null {
  if (!blob) {
    return null;
  }

  const ref = toPlainObject(blob["ref"]);
  const link = typeof ref?.["$link"] === "string" ? ref["$link"].trim() : "";
  return link || null;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeAlt(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 1000 ? `${normalized.slice(0, 999)}…` : normalized;
}
