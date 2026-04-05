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
  collection: z.literal("app.bsky.feed.post").optional(),
  canonicalRefId: z.string().optional(),
  operation: z.literal("delete"),
  bridge: bridgeSchema,
});

type DeleteEnvelope = z.infer<typeof deleteEnvelopeSchema>;

export class BskyPostDeleteTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    const parsed = deleteEnvelopeSchema.safeParse(input);
    return parsed.success && matchesPostDeleteEnvelope(parsed.data);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    const parsed = deleteEnvelopeSchema.safeParse(input);
    if (!parsed.success || !matchesPostDeleteEnvelope(parsed.data)) {
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
    canonicalUrl: toBskyUrl(envelope.repoDid, envelope.rkey),
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
  return `at://${repoDid}/app.bsky.feed.post/${rkey ?? "unknown"}`;
}

function toBskyUrl(repoDid: string, rkey?: string): string | null {
  return rkey ? `https://bsky.app/profile/${repoDid}/post/${rkey}` : null;
}

function matchesPostDeleteEnvelope(envelope: DeleteEnvelope): boolean {
  if (envelope.collection && envelope.collection !== "app.bsky.feed.post") {
    return false;
  }
  if (envelope.uri && !envelope.uri.includes("/app.bsky.feed.post/")) {
    return false;
  }
  return true;
}
