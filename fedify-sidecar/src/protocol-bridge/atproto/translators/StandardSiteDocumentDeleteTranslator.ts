import { z } from "zod";
import type { CanonicalIntent, CanonicalPostDeleteIntent } from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

const deleteEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  rkey: z.string().optional(),
  collection: z.literal("site.standard.document").optional(),
  canonicalRefId: z.string().optional(),
  operation: z.literal("delete"),
  bridge: bridgeSchema,
});

type DeleteEnvelope = z.infer<typeof deleteEnvelopeSchema>;

export class StandardSiteDocumentDeleteTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return deleteEnvelopeSchema.safeParse(input).success;
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    const parsed = deleteEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }

    return translateDeleteEnvelope(parsed.data, ctx);
  }
}

async function translateDeleteEnvelope(
  envelope: DeleteEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalPostDeleteIntent> {
  const now = (ctx.now ?? (() => new Date()))();
  const sourceAccountRef = await ctx.resolveActorRef({ did: envelope.repoDid });
  const uri = envelope.uri ?? deriveUri(envelope.repoDid, envelope.rkey);
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: envelope.canonicalRefId ?? uri,
    atUri: uri,
  });
  const draft: Omit<CanonicalPostDeleteIntent, "canonicalIntentId"> = {
    kind: "PostDelete",
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

function deriveUri(repoDid: string, rkey?: string): string {
  return `at://${repoDid}/site.standard.document/${rkey ?? "unknown"}`;
}
