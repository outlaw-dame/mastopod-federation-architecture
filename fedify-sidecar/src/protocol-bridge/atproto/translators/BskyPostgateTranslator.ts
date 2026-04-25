import { z } from "zod";
import type {
  CanonicalPostInteractionPolicyUpdateIntent,
  CanonicalQuotePolicy,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";

// ---------------------------------------------------------------------------
// ATProto postgate schemas
// ---------------------------------------------------------------------------

const disableRuleSchema = z.object({
  $type: z.literal("app.bsky.feed.postgate#disableRule"),
});

const postgateRecordSchema = z.object({
  $type: z.literal("app.bsky.feed.postgate"),
  post: z.string().startsWith("at://"),
  embeddingRules: z.array(z.unknown()).optional(),
  createdAt: z.string().optional(),
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
  rkey: z.string().optional(),
  cid: z.string().optional(),
  operation: z.enum(["create", "update", "delete"]).optional(),
  bridge: bridgeSchema,
  record: postgateRecordSchema.optional().nullable(),
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
    collection: z.literal("app.bsky.feed.postgate"),
    rkey: z.string(),
    cid: z.string().nullable().optional(),
    record: postgateRecordSchema.nullable().optional(),
  }),
});

type DirectEnvelope = z.infer<typeof directEnvelopeSchema>;

function isDirectEnvelope(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;

  if (typeof obj["repoDid"] !== "string" || !obj["repoDid"].startsWith("did:")) {
    return false;
  }
  // Explicit collection field takes priority.
  if (obj["collection"] != null) {
    return obj["collection"] === "app.bsky.feed.postgate";
  }
  // Record present: check $type.
  if (obj["record"] != null) {
    return (
      typeof obj["record"] === "object" &&
      (obj["record"] as Record<string, unknown>)["$type"] === "app.bsky.feed.postgate"
    );
  }
  // Delete envelope (no record): use URI to disambiguate collection.
  if (typeof obj["uri"] === "string") {
    return obj["uri"].includes("/app.bsky.feed.postgate/");
  }
  return false;
}

function isIngressEnvelope(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  const commit = obj["commit"];
  return (
    obj["eventType"] === "#commit" &&
    typeof obj["did"] === "string" &&
    obj["did"].startsWith("did:") &&
    commit != null &&
    typeof commit === "object" &&
    (commit as Record<string, unknown>)["collection"] === "app.bsky.feed.postgate"
  );
}

export class BskyPostgateTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return isDirectEnvelope(input) || isIngressEnvelope(input);
  }

  public async translate(
    input: unknown,
    ctx: TranslationContext,
  ): Promise<CanonicalPostInteractionPolicyUpdateIntent | null> {
    const ingress = ingressEnvelopeSchema.safeParse(input);
    if (ingress.success) {
      return translateIngress(ingress.data, ctx);
    }

    const direct = directEnvelopeSchema.safeParse(input);
    if (direct.success) {
      return translateDirect(direct.data, ctx);
    }

    return null;
  }
}

async function translateIngress(
  envelope: z.infer<typeof ingressEnvelopeSchema>,
  ctx: TranslationContext,
): Promise<CanonicalPostInteractionPolicyUpdateIntent | null> {
  return translateDirect(
    {
      repoDid: envelope.did,
      uri: `at://${envelope.did}/${envelope.commit.collection}/${envelope.commit.rkey}`,
      rkey: envelope.commit.rkey,
      cid: envelope.commit.cid ?? undefined,
      operation: envelope.commit.operation,
      bridge: envelope.bridge,
      record: envelope.commit.record ?? null,
    },
    ctx,
  );
}

async function translateDirect(
  envelope: DirectEnvelope,
  ctx: TranslationContext,
): Promise<CanonicalPostInteractionPolicyUpdateIntent | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const { repoDid } = envelope;
  const rkey = envelope.rkey ?? deriveRkey(envelope.uri);

  if (!rkey) {
    return null;
  }

  const sourceAccountRef = await ctx.resolveActorRef({ did: repoDid });
  const postAtUri = `at://${repoDid}/app.bsky.feed.post/${rkey}`;
  const objectRef = await ctx.resolveObjectRef({
    canonicalObjectId: postAtUri,
    atUri: postAtUri,
    cid: null,
  });

  const isDelete = envelope.operation === "delete";
  const canQuote: CanonicalQuotePolicy = isDelete
    ? "everyone"
    : parseQuotePolicyFromRecord(envelope.record);

  const provenance = toProvenance(
    envelope.bridge,
    envelope.uri ?? `at://${repoDid}/app.bsky.feed.postgate/${rkey}`,
    sourceAccountRef.canonicalAccountId ?? null,
  );

  const draft: Omit<CanonicalPostInteractionPolicyUpdateIntent, "canonicalIntentId"> = {
    kind: "PostInteractionPolicyUpdate",
    sourceProtocol: "atproto",
    sourceEventId: envelope.uri ?? `at://${repoDid}/app.bsky.feed.postgate/${rkey}`,
    sourceAccountRef,
    createdAt: envelope.record?.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "public",
    provenance,
    warnings: [],
    object: objectRef,
    // canReply intentionally absent: this event only concerns the quote gate.
    canQuote,
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the canonical `CanonicalQuotePolicy` from a postgate record's
 * `embeddingRules` array.
 *
 * Mapping:
 *   [disableRule] (or any non-empty set) → "nobody"
 *   []                                   → "everyone"
 *   absent                               → "everyone"
 */
function parseQuotePolicyFromRecord(
  record: z.infer<typeof postgateRecordSchema> | null | undefined,
): CanonicalQuotePolicy {
  if (!record) {
    return "everyone";
  }

  const rules = record.embeddingRules ?? [];
  const hasDisableRule = rules.some(
    (rule) => disableRuleSchema.safeParse(rule).success,
  );

  return hasDisableRule ? "nobody" : "everyone";
}

function deriveRkey(uri: string | undefined): string | null {
  if (!uri) return null;
  const match = uri.match(/^at:\/\/[^/]+\/[^/]+\/([^/]+)$/);
  return match?.[1] ?? null;
}

function toProvenance(
  bridge: DirectEnvelope["bridge"],
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
