import { z } from "zod";
import type { CanonicalIntent, CanonicalProfileUpdateIntent } from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { createParagraphBlocks } from "../../canonical/CanonicalContent.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import {
  ACTIVITYPODS_CUSTOM_EMOJIS_FIELD,
  activityPodsEmbeddedCustomEmojiFieldSchema,
  parseActivityPodsCustomEmojiField,
} from "../../../at-adapter/lexicon/ActivityPodsEmojiLexicon.js";

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

const recordSchema = z.object({
  $type: z.literal("app.bsky.actor.profile"),
  displayName: z.string().optional(),
  description: z.string().optional(),
  avatar: z.unknown().optional(),
  banner: z.unknown().optional(),
  [ACTIVITYPODS_CUSTOM_EMOJIS_FIELD]: activityPodsEmbeddedCustomEmojiFieldSchema.optional(),
});

const directEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  rkey: z.string().optional(),
  operation: z.enum(["create", "update"]).optional(),
  bridge: bridgeSchema,
  record: recordSchema,
});

const ingressEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  eventType: z.literal("#commit"),
  did: z.string().startsWith("did:"),
  bridge: bridgeSchema,
  commit: z.object({
    operation: z.enum(["create", "update"]),
    collection: z.literal("app.bsky.actor.profile"),
    rkey: z.string(),
    cid: z.string().nullable().optional(),
    record: recordSchema.nullable().optional(),
  }),
});

type DirectEnvelope = z.infer<typeof directEnvelopeSchema>;
type IngressEnvelope = z.infer<typeof ingressEnvelopeSchema>;

export class BskyProfileTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return directEnvelopeSchema.safeParse(input).success || ingressEnvelopeSchema.safeParse(input).success;
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    const direct = directEnvelopeSchema.safeParse(input);
    if (direct.success) {
      return translateDirectEnvelope(direct.data, ctx);
    }

    const ingress = ingressEnvelopeSchema.safeParse(input);
    if (!ingress.success || !ingress.data.commit.record) {
      return null;
    }

    return translateDirectEnvelope(
      {
        repoDid: ingress.data.did,
        uri: `at://${ingress.data.did}/${ingress.data.commit.collection}/${ingress.data.commit.rkey}`,
        rkey: ingress.data.commit.rkey,
        operation: ingress.data.commit.operation,
        bridge: ingress.data.bridge,
        record: ingress.data.commit.record,
      },
      ctx,
    );
  }
}

async function translateDirectEnvelope(
  envelope: DirectEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalProfileUpdateIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const warnings: CanonicalProfileUpdateIntent["warnings"] = [];
  const attachments = [
    ...(await translateBlobAttachment(envelope.repoDid, envelope.record.avatar, "avatar", ctx, warnings)),
    ...(await translateBlobAttachment(envelope.repoDid, envelope.record.banner, "banner", ctx, warnings)),
  ];
  const customEmojis = parseActivityPodsCustomEmojiField(
    envelope.record[ACTIVITYPODS_CUSTOM_EMOJIS_FIELD],
  );

  const draft: Omit<CanonicalProfileUpdateIntent, "canonicalIntentId"> = {
    kind: "ProfileUpdate",
    sourceProtocol: "atproto",
    sourceEventId: envelope.uri ?? `at://${envelope.repoDid}/app.bsky.actor.profile/${envelope.rkey ?? "self"}`,
    sourceAccountRef,
    createdAt: now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public",
    provenance: toProvenance(
      envelope.bridge,
      envelope.uri ?? `at://${envelope.repoDid}/app.bsky.actor.profile/${envelope.rkey ?? "self"}`,
      sourceAccountRef.canonicalAccountId ?? null,
    ),
    warnings,
    content: {
      kind: "profile",
      title: envelope.record.displayName ?? null,
      summary: null,
      plaintext: envelope.record.description ?? "",
      html: null,
      language: null,
      blocks: createParagraphBlocks(envelope.record.description ?? ""),
      facets: [],
      customEmojis,
      attachments,
      externalUrl: sourceAccountRef.activityPubActorUri ?? null,
    },
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
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

const blobRefSchema = z.object({
  $type: z.literal("blob").optional(),
  ref: z.object({
    $link: z.string().min(1),
  }),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

async function translateBlobAttachment(
  repoDid: string,
  blob: unknown,
  role: "avatar" | "banner",
  ctx: TranslationContext,
  warnings: CanonicalProfileUpdateIntent["warnings"],
) {
  if (!blob) {
    return [];
  }

  const parsed = blobRefSchema.safeParse(blob);
  if (!parsed.success) {
    warnings.push({
      code: "AT_PROFILE_MEDIA_INVALID",
      message: `AT profile ${role} field did not match the expected blob reference shape.`,
      lossiness: "minor",
    });
    return [];
  }

  const cid = parsed.data.ref.$link;
  const url = ctx.resolveBlobUrl ? await ctx.resolveBlobUrl(repoDid, cid) : null;
  if (!url) {
    warnings.push({
      code: "AT_PROFILE_MEDIA_URL_UNRESOLVED",
      message: `AT profile ${role} blob could not be mapped to a fetchable URL for ActivityPub projection.`,
      lossiness: "minor",
    });
  }

  return [
    {
      attachmentId: `${repoDid}:${role}:${cid}`,
      mediaType: parsed.data.mimeType ?? "image/*",
      cid,
      url,
      role,
      alt: null,
      width: null,
      height: null,
      blurhash: null,
    },
  ];
}
