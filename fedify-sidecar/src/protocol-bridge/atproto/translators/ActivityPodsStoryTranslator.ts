import { z } from "zod";
import {
  ACTIVITYPODS_STORY_COLLECTION,
  activityPodsStoryRecordSchema,
  normalizeActivityPodsStoryRecord,
} from "../../../at-adapter/lexicon/ActivityPodsStoryLexicon.js";
import type {
  CanonicalIntent,
  CanonicalStoryCreateIntent,
  CanonicalStoryDeleteIntent,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto", "activitypods"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

const storyRecordSchema = activityPodsStoryRecordSchema.passthrough();

const directCreateEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  cid: z.string().optional(),
  rkey: z.string().optional(),
  canonicalRefId: z.string().optional(),
  operation: z.enum(["create", "update"]).optional(),
  bridge: bridgeSchema,
  record: storyRecordSchema,
});

const directDeleteEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  rkey: z.string().optional(),
  collection: z.literal(ACTIVITYPODS_STORY_COLLECTION).optional(),
  canonicalRefId: z.string().optional(),
  operation: z.literal("delete"),
  bridge: bridgeSchema,
});

const ingressEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  eventType: z.literal("#commit"),
  did: z.string().startsWith("did:"),
  source: z.string().optional(),
  verifiedAt: z.string().optional(),
  bridge: bridgeSchema,
  commit: z.object({
    operation: z.enum(["create", "update", "delete"]),
    collection: z.literal(ACTIVITYPODS_STORY_COLLECTION),
    rkey: z.string(),
    cid: z.string().nullable().optional(),
    canonicalRefId: z.string().optional(),
    record: storyRecordSchema.nullable().optional(),
    bridge: bridgeSchema,
  }),
});

type DirectCreateEnvelope = z.infer<typeof directCreateEnvelopeSchema>;
type DirectDeleteEnvelope = z.infer<typeof directDeleteEnvelopeSchema>;
type IngressEnvelope = z.infer<typeof ingressEnvelopeSchema>;

export class ActivityPodsStoryTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return (
      directCreateEnvelopeSchema.safeParse(input).success ||
      directDeleteEnvelopeSchema.safeParse(input).success ||
      ingressEnvelopeSchema.safeParse(input).success
    );
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    const directCreate = directCreateEnvelopeSchema.safeParse(input);
    if (directCreate.success) {
      return translateStoryCreate(directCreate.data, ctx);
    }

    const directDelete = directDeleteEnvelopeSchema.safeParse(input);
    if (directDelete.success) {
      return translateStoryDelete(directDelete.data, ctx);
    }

    const ingress = ingressEnvelopeSchema.safeParse(input);
    if (ingress.success) {
      return translateIngressEnvelope(ingress.data, ctx);
    }

    return null;
  }
}

async function translateIngressEnvelope(
  envelope: IngressEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalIntent | null> {
  const uri = `at://${envelope.did}/${ACTIVITYPODS_STORY_COLLECTION}/${envelope.commit.rkey}`;
  if (envelope.commit.operation === "delete") {
    return translateStoryDelete(
      {
        repoDid: envelope.did,
        uri,
        rkey: envelope.commit.rkey,
        canonicalRefId: envelope.commit.canonicalRefId,
        operation: "delete",
        bridge: envelope.commit.bridge ?? envelope.bridge,
      },
      ctx,
    );
  }

  if (!envelope.commit.record) {
    return null;
  }

  return translateStoryCreate(
    {
      repoDid: envelope.did,
      uri,
      cid: envelope.commit.cid ?? undefined,
      rkey: envelope.commit.rkey,
      canonicalRefId: envelope.commit.canonicalRefId,
      operation: envelope.commit.operation,
      bridge: envelope.commit.bridge ?? envelope.bridge,
      record: envelope.commit.record,
    },
    ctx,
  );
}

async function translateStoryCreate(
  envelope: DirectCreateEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalStoryCreateIntent | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const story = normalizeActivityPodsStoryRecord(envelope.record, { now });
  if (!story) {
    return null;
  }

  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectUri = envelope.uri ?? `at://${envelope.repoDid}/${ACTIVITYPODS_STORY_COLLECTION}/${envelope.rkey ?? envelope.cid ?? "unknown"}`;
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.canonicalRefId ?? objectUri,
    atUri: objectUri,
    cid: envelope.cid ?? null,
  });
  const draft: Omit<CanonicalStoryCreateIntent, "canonicalIntentId"> = {
    kind: "StoryCreate",
    sourceProtocol: "atproto",
    sourceEventId: objectUri,
    sourceAccountRef,
    createdAt: story.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: story.visibility ?? "public",
    provenance: toProvenance(envelope.bridge, objectUri, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
    media: story.media,
    text: story.text ?? null,
    facets: story.facets ?? [],
    links: story.links ?? [],
    labels: story.labels ?? [],
    allowReplies: story.allowReplies ?? true,
    langs: story.langs ?? [],
    expiresAt: story.expiresAt!,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

async function translateStoryDelete(
  envelope: DirectDeleteEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalStoryDeleteIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const uri = envelope.uri ?? `at://${envelope.repoDid}/${ACTIVITYPODS_STORY_COLLECTION}/${envelope.rkey ?? "unknown"}`;
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.canonicalRefId ?? uri,
    atUri: uri,
  });
  const draft: Omit<CanonicalStoryDeleteIntent, "canonicalIntentId"> = {
    kind: "StoryDelete",
    sourceProtocol: "atproto",
    sourceEventId: uri,
    sourceAccountRef,
    createdAt: now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public",
    provenance: toProvenance(envelope.bridge, uri, sourceAccountRef.canonicalAccountId ?? null),
    warnings: [],
    object: objectRef,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

function toProvenance(
  bridge: DirectCreateEnvelope["bridge"] | DirectDeleteEnvelope["bridge"],
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
