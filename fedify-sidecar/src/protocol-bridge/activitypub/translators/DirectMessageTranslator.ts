import type { CanonicalDirectMessageIntent, CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { buildCanonicalIntentId } from "../../idempotency/CanonicalIntentIdBuilder.js";
import { z } from "zod";

const actorSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

const directMessageActivitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("Create"),
  actor: actorSchema,
  published: z.string().optional(),
  to: z.union([z.string().url(), z.array(z.string().url())]).optional(),
  object: z.object({
    type: z.literal("Note"),
    content: z.string(),
    attributedTo: z.string().url().optional(),
    id: z.string().optional(),
    inReplyTo: z.string().optional(),
  }).optional(),
});

export type DirectMessageActivity = z.infer<typeof directMessageActivitySchema>;

/** Maximum allowed message text length — mirrors the Memory API limit. */
const MAX_TEXT_LEN = 10_000;

/** Public streams indicator from the ActivityStreams namespace. */
const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";

function getActorId(actor: z.infer<typeof actorSchema>): string {
  return typeof actor === "string" ? actor : actor.id;
}

/**
 * Translator for ActivityPub direct messages.
 *
 * Matches `Create(Note)` activities addressed to a single non-public recipient.
 * Must be registered *before* `CreateNoteTranslator` in the translator chain
 * because both translators match the same activity type — this one applies the
 * additional single-recipient constraint.
 */
export class DirectMessageTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    try {
      const parsed = directMessageActivitySchema.safeParse(input);
      if (!parsed.success) return false;

      const activity = parsed.data;
      const recipients = Array.isArray(activity.to)
        ? activity.to
        : activity.to
        ? [activity.to]
        : [];

      // Single recipient, not addressed to the public stream
      return (
        recipients.length === 1 &&
        recipients[0] !== PUBLIC_AUDIENCE
      );
    } catch {
      return false;
    }
  }

  public async translate(
    input: unknown,
    ctx: TranslationContext,
  ): Promise<CanonicalIntent | null> {
    return translateDirectMessageActivity(input, ctx);
  }
}

/**
 * Translate an ActivityPub `Create(Note)` direct message to a
 * `CanonicalDirectMessageIntent`.
 */
export async function translateDirectMessageActivity(
  input: unknown,
  ctx: TranslationContext,
): Promise<CanonicalDirectMessageIntent | null> {
  const parsed = directMessageActivitySchema.safeParse(input);
  if (!parsed.success) return null;

  const activity = parsed.data;
  const recipients = Array.isArray(activity.to)
    ? activity.to
    : activity.to
    ? [activity.to]
    : [];

  if (recipients.length !== 1 || recipients[0] === PUBLIC_AUDIENCE) return null;

  const now = (ctx.now ?? (() => new Date()))();
  const actorId = getActorId(activity.actor);

  const sourceAccountRef = await ctx.resolveActorRef({ activityPubActorUri: actorId });
  const recipientRef = await ctx.resolveActorRef({ activityPubActorUri: recipients[0] });

  if (!sourceAccountRef || !recipientRef) {
    return null;
  }

  // Strip null bytes and enforce max length at translation time
  // eslint-disable-next-line no-control-regex
  const rawText = (activity.object?.content ?? "").replace(/\x00/g, "").trim();
  const text = rawText.slice(0, MAX_TEXT_LEN);

  const messageId = activity.object?.id ?? `${actorId}#dm-${Date.now()}`;

  const draft: Omit<CanonicalDirectMessageIntent, "canonicalIntentId"> = {
    kind: "DirectMessage",
    sourceProtocol: "activitypub",
    sourceEventId: activity.id,
    sourceAccountRef,
    createdAt: activity.published ?? now.toISOString(),
    observedAt: now.toISOString(),
    visibility: "direct",
    provenance: {
      originProtocol: "activitypub",
      originEventId: activity.id,
      originAccountId: sourceAccountRef.canonicalAccountId ?? null,
      mirroredFromCanonicalIntentId: null,
      projectionMode: "native",
    },
    warnings: [],
    sender: sourceAccountRef,
    recipient: recipientRef,
    text,
    messageId,
    timestamp: activity.published ?? now.toISOString(),
  };

  return {
    ...draft,
    canonicalIntentId: buildCanonicalIntentId(draft),
  };
}
