import { createHash } from "node:crypto";
import { canonicalActorIdentityKey } from "../canonical/CanonicalActorRef.js";
import {
  canonicalFollowTargetIdentityKey,
  canonicalReactionIdentityKey,
  type CanonicalIntent,
} from "../canonical/CanonicalIntent.js";
import { canonicalObjectIdentityKey } from "../canonical/CanonicalObjectRef.js";

type CanonicalIntentDraft = CanonicalIntent extends infer T
  ? T extends { canonicalIntentId: string }
    ? Omit<T, "canonicalIntentId">
    : never
  : never;

export function buildCanonicalIntentId(intent: CanonicalIntentDraft | CanonicalIntent): string {
  const payload = {
    sourceProtocol: intent.sourceProtocol,
    sourceEventId: intent.sourceEventId,
    actor: canonicalActorIdentityKey(intent.sourceAccountRef),
    kind: intent.kind,
    target: normalizedTarget(intent),
    contentDigest: normalizedContentDigest(intent),
  };

  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizedTarget(intent: CanonicalIntentDraft | CanonicalIntent): string {
  switch (intent.kind) {
    case "ReportCreate":
      return intent.subject.kind === "account"
        ? canonicalActorIdentityKey(intent.subject.actor)
        : canonicalObjectIdentityKey(intent.subject.object);
    case "PostCreate":
    case "PostEdit":
    case "PostDelete":
    case "PostInteractionPolicyUpdate":
    case "PollCreate":
    case "PollEdit":
    case "PollDelete":
    case "PollVoteAdd":
    case "ReactionAdd":
    case "ReactionRemove":
    case "ShareAdd":
    case "ShareRemove":
      return canonicalObjectIdentityKey(intent.object);
    case "FollowAdd":
    case "FollowRemove":
      return canonicalFollowTargetIdentityKey(intent);
    case "ProfileUpdate":
    case "AccountState":
      return canonicalActorIdentityKey(intent.sourceAccountRef);
  }
}

function normalizedContentDigest(intent: CanonicalIntentDraft | CanonicalIntent): string {
  switch (intent.kind) {
    case "ReportCreate":
      return createHash("sha256")
        .update(
          stableStringify({
            subjectKind: intent.subject.kind,
            authoritativeProtocol: intent.subject.authoritativeProtocol ?? null,
            reasonType: intent.reasonType,
            reason: intent.reason ?? null,
            evidence: (intent.evidenceObjectRefs ?? []).map((ref) => canonicalObjectIdentityKey(ref)),
            requestedForwardingRemote: intent.requestedForwarding?.remote ?? null,
            clientContext: intent.clientContext ?? null,
          }),
        )
        .digest("hex");
    case "PostCreate":
    case "PostEdit":
      return createHash("sha256")
        .update(
          stableStringify({
            kind: intent.content.kind,
            title: intent.content.title ?? null,
            summary: intent.content.summary ?? null,
            plaintext: intent.content.plaintext,
            language: intent.content.language ?? null,
            facets: intent.content.facets,
            customEmojis: intent.content.customEmojis ?? [],
            attachments: intent.content.attachments,
            externalUrl: intent.content.externalUrl ?? null,
            quoteOf: intent.quoteOf ? canonicalObjectIdentityKey(intent.quoteOf) : null,
          }),
        )
        .digest("hex");
    case "ReactionAdd":
    case "ReactionRemove":
      return createHash("sha256")
        .update(
          stableStringify({
            reactionType: intent.reactionType,
            reactionIdentity: canonicalReactionIdentityKey(intent),
          }),
        )
        .digest("hex");
    case "ShareAdd":
    case "ShareRemove":
      return canonicalObjectIdentityKey(intent.object);
    case "FollowAdd":
    case "FollowRemove":
      return canonicalFollowTargetIdentityKey(intent);
    case "ProfileUpdate":
      return createHash("sha256")
        .update(
          stableStringify({
            plaintext: intent.content.plaintext,
            title: intent.content.title ?? null,
            summary: intent.content.summary ?? null,
            customEmojis: intent.content.customEmojis ?? [],
          }),
        )
        .digest("hex");
    case "PostDelete":
    case "PollDelete":
      return canonicalObjectIdentityKey(intent.object);
    case "PollCreate":
    case "PollEdit":
      return createHash("sha256")
        .update(
          stableStringify({
            mode: intent.mode,
            options: intent.options.map((o) => ({ name: o.name, voteCount: o.voteCount })),
            endTime: intent.endTime ?? null,
          }),
        )
        .digest("hex");
    case "PollVoteAdd":
      return createHash("sha256")
        .update(
          stableStringify({
            pollRef: canonicalObjectIdentityKey(intent.pollRef),
            optionName: intent.optionName,
          }),
        )
        .digest("hex");
    case "PostInteractionPolicyUpdate":
      return createHash("sha256")
        .update(
          stableStringify({
            canReply: intent.canReply ?? null,
            canQuote: intent.canQuote ?? null,
          }),
        )
        .digest("hex");
    case "AccountState":
      return intent.state;
  }
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, function replacer(_key, currentValue) {
    if (!currentValue || typeof currentValue !== "object") {
      return currentValue;
    }

    if (seen.has(currentValue)) {
      return "[Circular]";
    }
    seen.add(currentValue);

    if (Array.isArray(currentValue)) {
      return currentValue;
    }

    return Object.keys(currentValue)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = (currentValue as Record<string, unknown>)[key];
        return accumulator;
      }, {});
  });
}
