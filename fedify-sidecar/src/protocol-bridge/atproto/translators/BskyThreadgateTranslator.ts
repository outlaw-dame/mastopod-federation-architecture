import { z } from "zod";
import type {
  CanonicalPostInteractionPolicyUpdateIntent,
  CanonicalReplyPolicy,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalProvenance } from "../../canonical/CanonicalEnvelope.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";

// ---------------------------------------------------------------------------
// ATProto threadgate rule schemas
// ---------------------------------------------------------------------------

const followingRuleSchema = z.object({
  $type: z.literal("app.bsky.feed.threadgate#followingRule"),
});

const mentionRuleSchema = z.object({
  $type: z.literal("app.bsky.feed.threadgate#mentionRule"),
});

const threadgateRecordSchema = z.object({
  $type: z.literal("app.bsky.feed.threadgate"),
  post: z.string().startsWith("at://"),
  allow: z.array(z.unknown()).optional(),
  createdAt: z.string().optional(),
});

const bridgeSchema = z.object({
  originProtocol: z.enum(["activitypub", "atproto"]),
  originEventId: z.string().min(1),
  originAccountId: z.string().optional(),
  mirroredFromCanonicalIntentId: z.string().optional().nullable(),
  projectionMode: z.enum(["native", "mirrored"]).optional(),
}).optional();

// Direct envelope: emitted by the ActivityPods bridge layer.
const directEnvelopeSchema = z.object({
  repoDid: z.string().startsWith("did:"),
  uri: z.string().startsWith("at://").optional(),
  rkey: z.string().optional(),
  cid: z.string().optional(),
  operation: z.enum(["create", "update", "delete"]).optional(),
  bridge: bridgeSchema,
  record: threadgateRecordSchema.optional().nullable(),
});

// Firehose ingress envelope: sourced from the ATProto firehose relay.
const ingressEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  eventType: z.literal("#commit"),
  did: z.string().startsWith("did:"),
  source: z.string().optional(),
  verifiedAt: z.string().optional(),
  bridge: bridgeSchema,
  commit: z.object({
    operation: z.enum(["create", "update", "delete"]),
    collection: z.literal("app.bsky.feed.threadgate"),
    rkey: z.string(),
    cid: z.string().nullable().optional(),
    record: threadgateRecordSchema.nullable().optional(),
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
    return obj["collection"] === "app.bsky.feed.threadgate";
  }
  // Record present: check $type.
  if (obj["record"] != null) {
    return (
      typeof obj["record"] === "object" &&
      (obj["record"] as Record<string, unknown>)["$type"] === "app.bsky.feed.threadgate"
    );
  }
  // Delete envelope (no record): use URI to disambiguate collection.
  if (typeof obj["uri"] === "string") {
    return obj["uri"].includes("/app.bsky.feed.threadgate/");
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
    (commit as Record<string, unknown>)["collection"] === "app.bsky.feed.threadgate"
  );
}

export class BskyThreadgateTranslator implements ProtocolTranslator<unknown> {
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
  const canReply: CanonicalReplyPolicy = isDelete
    ? "everyone"
    : parseReplyPolicyFromRecord(envelope.record);

  const provenance = toProvenance(
    envelope.bridge,
    envelope.uri ?? `at://${repoDid}/app.bsky.feed.threadgate/${rkey}`,
    sourceAccountRef.canonicalAccountId ?? null,
  );

  const draft: Omit<CanonicalPostInteractionPolicyUpdateIntent, "canonicalIntentId"> = {
    kind: "PostInteractionPolicyUpdate",
    sourceProtocol: "atproto",
    sourceEventId: envelope.uri ?? `at://${repoDid}/app.bsky.feed.threadgate/${rkey}`,
    sourceAccountRef,
    createdAt: envelope.record?.createdAt ?? now.toISOString(),
    observedAt: now.toISOString(),
    // Gate records do not convey visibility; default to public (gates restrict
    // interaction type, not audience).
    visibility: "public",
    provenance,
    warnings: [],
    object: objectRef,
    canReply,
    // canQuote intentionally absent: this event only concerns the reply gate.
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
 * Derive the canonical `CanonicalReplyPolicy` from a threadgate record's
 * `allow` array.
 *
 * Mapping:
 *   [followingRule]         → "followers"
 *   [mentionRule]           → "mentioned"
 *   [followingRule, mentionRule] or any unsupported mixed set → "followers"
 *     (more permissive interpretation; a warning is not emitted here because
 *      the data still round-trips safely — it just loses the "mentioned only"
 *      distinction which is an inherent AT/AP gap)
 *   []                      → "nobody"
 *   absent                  → "nobody" (treat missing allow as empty)
 */
function parseReplyPolicyFromRecord(
  record: z.infer<typeof threadgateRecordSchema> | null | undefined,
): CanonicalReplyPolicy {
  if (!record) {
    return "nobody";
  }

  const allow = record.allow ?? [];
  const hasFollowing = allow.some(
    (rule) => followingRuleSchema.safeParse(rule).success,
  );
  const hasMention = allow.some(
    (rule) => mentionRuleSchema.safeParse(rule).success,
  );

  if (hasFollowing) {
    return "followers";
  }
  if (hasMention) {
    return "mentioned";
  }
  return "nobody";
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
