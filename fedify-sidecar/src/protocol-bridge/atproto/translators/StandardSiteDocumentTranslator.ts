import { z } from "zod";
import type { CanonicalIntent, CanonicalPostCreateIntent, CanonicalPostEditIntent } from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { createParagraphBlocks } from "../../canonical/CanonicalContent.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { htmlToCanonicalBlocks } from "../../text/HtmlToCanonicalBlocks.js";
import { renderMarkdownToHtml } from "../../../utils/markdown.js";
import { fetchOpenGraph } from "../../../utils/opengraph.js";
import {
  ACTIVITYPODS_CUSTOM_EMOJIS_FIELD,
  activityPodsEmbeddedCustomEmojiFieldSchema,
  parseActivityPodsCustomEmojiField,
} from "../../../at-adapter/lexicon/ActivityPodsEmojiLexicon.js";

const recordSchema = z.object({
  $type: z.literal("site.standard.document"),
  title: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  text: z.string().max(100_000),
  publishedAt: z.string().optional(),
  url: z.string().url().optional().nullable(),
  [ACTIVITYPODS_CUSTOM_EMOJIS_FIELD]: activityPodsEmbeddedCustomEmojiFieldSchema.optional(),
});

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

const directEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  cid: z.string().optional(),
  rkey: z.string().optional(),
  canonicalRefId: z.string().optional(),
  operation: z.enum(["create", "update"]).optional(),
  bridge: bridgeSchema,
  record: recordSchema,
});

const ingressEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  eventType: z.literal("#commit"),
  did: z.string().startsWith("did:"),
  source: z.string().optional(),
  verifiedAt: z.string().optional(),
  bridge: bridgeSchema,
  commit: z.object({
    operation: z.enum(["create", "update"]),
    collection: z.literal("site.standard.document"),
    rkey: z.string(),
    cid: z.string().nullable().optional(),
    canonicalRefId: z.string().optional(),
    record: recordSchema.nullable().optional(),
    bridge: z.object({
      canonicalIntentId: z.string(),
      sourceProtocol: z.enum(["activitypub", "atproto"]),
      provenance: z.object({
        originProtocol: z.enum(["activitypub", "atproto"]),
        originEventId: z.string(),
        originAccountId: z.string().optional().nullable(),
        mirroredFromCanonicalIntentId: z.string().optional().nullable(),
        projectionMode: z.enum(["native", "mirrored"]),
      }),
    }).optional(),
  }),
});

type DirectEnvelope = z.infer<typeof directEnvelopeSchema>;
type IngressEnvelope = z.infer<typeof ingressEnvelopeSchema>;

export class StandardSiteDocumentTranslator implements ProtocolTranslator<unknown> {
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
  const objectUri = envelope.uri ?? `at://${envelope.repoDid}/site.standard.document/${envelope.rkey ?? envelope.cid ?? "unknown"}`;
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.canonicalRefId ?? objectUri,
    atUri: objectUri,
    cid: envelope.cid ?? null,
    canonicalUrl: envelope.record.url ?? null,
  });
  const provenance = toProvenance(
    envelope.bridge,
    envelope.uri ?? objectUri,
    sourceAccountRef.canonicalAccountId ?? null,
  );

  // Long-form text is always treated as Markdown for site.standard.document.
  const rawText = envelope.record.text;
  const renderedHtml = renderMarkdownToHtml(rawText);
  const { blocks } = renderedHtml.trim()
    ? htmlToCanonicalBlocks(renderedHtml)
    : { blocks: createParagraphBlocks(rawText) };

  // OpenGraph live preview — use the document's canonical URL if present.
  const previewUrl = envelope.record.url ?? null;
  const ogData = previewUrl ? await fetchOpenGraph(previewUrl) : null;
  const linkPreview = ogData
      ? {
        uri: ogData.uri,
        title: ogData.title,
        description: ogData.description ?? null,
        thumbUrl: ogData.thumbUrl ?? null,
        ...(ogData.authorName ? { authorName: ogData.authorName } : {}),
        ...(ogData.authorUrl ? { authorUrl: ogData.authorUrl } : {}),
        ...(ogData.authors && ogData.authors.length > 0 ? { authors: ogData.authors } : {}),
      }
      : null;
  const customEmojis = parseActivityPodsCustomEmojiField(
    envelope.record[ACTIVITYPODS_CUSTOM_EMOJIS_FIELD],
  );

  const baseDraft = {
    sourceProtocol: "atproto" as const,
    sourceEventId: envelope.uri ?? objectUri,
    sourceAccountRef,
    createdAt: envelope.record.publishedAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public" as const,
    provenance,
    warnings: [],
    object: objectRef,
    inReplyTo: null,
    content: {
      kind: "article" as const,
      title: envelope.record.title ?? null,
      summary: envelope.record.summary ?? null,
      plaintext: envelope.record.text,
      html: renderedHtml || null,
      language: null,
      blocks,
      facets: [],
      customEmojis,
      attachments: [],
      externalUrl: envelope.record.url ?? null,
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
      bridge: envelope.commit.bridge
        ? {
            originProtocol: envelope.commit.bridge.provenance.originProtocol,
            originEventId: envelope.commit.bridge.provenance.originEventId,
            ...(typeof envelope.commit.bridge.provenance.originAccountId === "string"
              ? { originAccountId: envelope.commit.bridge.provenance.originAccountId }
              : {}),
            ...(typeof envelope.commit.bridge.provenance.mirroredFromCanonicalIntentId === "string"
              ? {
                  mirroredFromCanonicalIntentId:
                    envelope.commit.bridge.provenance.mirroredFromCanonicalIntentId,
                }
              : {}),
            projectionMode: envelope.commit.bridge.provenance.projectionMode,
          }
        : envelope.bridge,
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
