import type { CanonicalActorRef } from "./CanonicalActorRef.js";
import type { CanonicalContent, CanonicalCustomEmoji, CanonicalPollOption } from "./CanonicalContent.js";
import type { CanonicalIntentBase } from "./CanonicalEnvelope.js";
import type { CanonicalObjectRef } from "./CanonicalObjectRef.js";
import { canonicalActorIdentityKey } from "./CanonicalActorRef.js";
import { canonicalObjectIdentityKey } from "./CanonicalObjectRef.js";

// ---------------------------------------------------------------------------
// Interaction policy
// ---------------------------------------------------------------------------

/**
 * Who may reply to a post.
 *
 * Maps to ATProto `app.bsky.feed.threadgate` rules and to the GoToSocial
 * `interactionPolicy.canReply` ActivityPub vocabulary.
 *
 * - "everyone"   → no threadgate; AP `automaticApproval: PUBLIC`
 * - "followers"  → threadgate `followingRule`; AP `automaticApproval: ${actor}/followers`
 * - "mentioned"  → threadgate `mentionRule`; AP has no direct equivalent (emitted as empty)
 * - "nobody"     → threadgate `allow: []`; AP `canReply: {}` (empty = no one permitted)
 */
export type CanonicalReplyPolicy = "everyone" | "followers" | "mentioned" | "nobody";

/**
 * Who may quote a post.
 *
 * Maps to ATProto `app.bsky.feed.postgate` embedding rules and to the
 * FEP-044f / GoToSocial `interactionPolicy.canQuote` ActivityPub vocabulary.
 *
 * - "everyone" → no postgate; AP `automaticApproval: PUBLIC`
 * - "nobody"   → postgate `disableRule`; AP `canQuote: {}` (empty)
 */
export type CanonicalQuotePolicy = "everyone" | "nobody";

/**
 * Cross-protocol interaction policy for a post.  Optional: when absent the
 * defaults apply (everyone can reply, everyone can quote).
 */
export interface CanonicalInteractionPolicy {
  canReply: CanonicalReplyPolicy;
  canQuote: CanonicalQuotePolicy;
}

export type CanonicalIntentKind =
  | "PostCreate"
  | "PostEdit"
  | "PostDelete"
  | "PostInteractionPolicyUpdate"
  | "PollCreate"
  | "PollEdit"
  | "PollDelete"
  | "PollVoteAdd"
  | "ReactionAdd"
  | "ReactionRemove"
  | "ShareAdd"
  | "ShareRemove"
  | "FollowAdd"
  | "FollowRemove"
  | "ProfileUpdate"
  | "AccountState";

export interface CanonicalPostCreateIntent extends CanonicalIntentBase {
  kind: "PostCreate";
  object: CanonicalObjectRef;
  content: CanonicalContent;
  inReplyTo?: CanonicalObjectRef | null;
  /** FEP-7888 / FEP-11dd: root of the reply thread, used as the AP `context` property. */
  replyRoot?: CanonicalObjectRef | null;
  quoteOf?: CanonicalObjectRef | null;
  /**
   * Cross-protocol interaction policy.  Absent/null means "use defaults"
   * (everyone can reply, everyone can quote).  Set only when the originating
   * platform advertises a non-default policy.
   */
  interactionPolicy?: CanonicalInteractionPolicy | null;
}

export interface CanonicalPostEditIntent extends CanonicalIntentBase {
  kind: "PostEdit";
  object: CanonicalObjectRef;
  content: CanonicalContent;
  inReplyTo?: CanonicalObjectRef | null;
  /** FEP-7888 / FEP-11dd: root of the reply thread, used as the AP `context` property. */
  replyRoot?: CanonicalObjectRef | null;
  quoteOf?: CanonicalObjectRef | null;
  /**
   * Cross-protocol interaction policy.  Absent/null means "use defaults"
   * (everyone can reply, everyone can quote).  Set only when the originating
   * platform advertises a non-default policy.
   */
  interactionPolicy?: CanonicalInteractionPolicy | null;
}

export interface CanonicalPostDeleteIntent extends CanonicalIntentBase {
  kind: "PostDelete";
  object: CanonicalObjectRef;
}

/**
 * Signals that the interaction policy for an existing post has changed.
 * Produced by ATProto threadgate / postgate commit events, allowing the policy
 * to be reflected cross-protocol (e.g. as an AP Update activity containing an
 * updated `interactionPolicy` object).
 *
 * Both `canReply` and `canQuote` are optional.  Absent means "no change for
 * that axis" — projectors SHOULD apply defaults ("everyone") for absent fields
 * rather than attempting to fetch current remote state.
 *
 * ATProto context:
 *   - threadgate (app.bsky.feed.threadgate) controls `canReply`
 *   - postgate   (app.bsky.feed.postgate)   controls `canQuote`
 *   Each gate record shares an rkey with its parent post.  Because they arrive
 *   as separate firehose commit events the intent carries only the axis that
 *   changed; the other axis is left absent.
 */
export interface CanonicalPostInteractionPolicyUpdateIntent extends CanonicalIntentBase {
  kind: "PostInteractionPolicyUpdate";
  /** The post whose interaction policy is being updated. */
  object: CanonicalObjectRef;
  /**
   * New reply policy.  Absent/null means this event only concerns `canQuote`;
   * projectors should treat the reply policy as "everyone" (default).
   */
  canReply?: CanonicalReplyPolicy | null;
  /**
   * New quote policy.  Absent/null means this event only concerns `canReply`;
   * projectors should treat the quote policy as "everyone" (default).
   */
  canQuote?: CanonicalQuotePolicy | null;
}

// ---------------------------------------------------------------------------
// Poll intents (FEP-9967)
// ---------------------------------------------------------------------------

/**
 * A new poll (Question) has been published.
 *
 * FEP-9967: The Question object carries `oneOf` (single-choice) or `anyOf`
 * (multiple-choice) option arrays.  Vote counts in `options[].voteCount` are
 * the totals at the time the event was observed.
 */
export interface CanonicalPollCreateIntent extends CanonicalIntentBase {
  kind: "PollCreate";
  /** The published Question object. */
  object: CanonicalObjectRef;
  /** The poll question text (AP `content` or `name`). */
  question: string;
  /** Voting mode: "oneOf" = single choice, "anyOf" = multiple choice. */
  mode: "oneOf" | "anyOf";
  /** Poll options, in order.  Names MUST be unique within a poll. */
  options: CanonicalPollOption[];
  /** ISO 8601 end time after which voting closes.  Absent = no expiry. */
  endTime?: string | null;
  /**
   * Mastodon extension: total unique voters (as opposed to total votes).
   * Absent when the originating server does not advertise it.
   */
  votersCount?: number | null;
  interactionPolicy?: CanonicalInteractionPolicy | null;
}

/**
 * An existing poll (Question) has been updated — either the author changed
 * options/type, or vote counts changed because a vote was received and the
 * author published an Update.
 */
export interface CanonicalPollEditIntent extends CanonicalIntentBase {
  kind: "PollEdit";
  object: CanonicalObjectRef;
  question: string;
  mode: "oneOf" | "anyOf";
  options: CanonicalPollOption[];
  endTime?: string | null;
  votersCount?: number | null;
  interactionPolicy?: CanonicalInteractionPolicy | null;
}

/** A poll has been deleted. */
export interface CanonicalPollDeleteIntent extends CanonicalIntentBase {
  kind: "PollDelete";
  object: CanonicalObjectRef;
}

/**
 * A vote has been cast.
 *
 * FEP-9967: votes are represented as `Note` objects with `name` = option text
 * and `inReplyTo` = poll URI, sent via Create to the poll author only.
 * `object` is the canonical ref for the vote Note itself.
 * `pollRef` is the poll being voted on.
 */
export interface CanonicalPollVoteAddIntent extends CanonicalIntentBase {
  kind: "PollVoteAdd";
  /** The vote Note object itself. */
  object: CanonicalObjectRef;
  /** The poll being voted on. */
  pollRef: CanonicalObjectRef;
  /** The name of the poll option being selected. */
  optionName: string;
}

export interface CanonicalReactionAddIntent extends CanonicalIntentBase {
  kind: "ReactionAdd";
  object: CanonicalObjectRef;
  reactionType: "like" | "emoji";
  reactionContent?: string | null;
  reactionEmoji?: CanonicalCustomEmoji | null;
}

export interface CanonicalReactionRemoveIntent extends CanonicalIntentBase {
  kind: "ReactionRemove";
  object: CanonicalObjectRef;
  reactionType: "like" | "emoji";
  reactionContent?: string | null;
  reactionEmoji?: CanonicalCustomEmoji | null;
}

export interface CanonicalShareAddIntent extends CanonicalIntentBase {
  kind: "ShareAdd";
  object: CanonicalObjectRef;
}

export interface CanonicalShareRemoveIntent extends CanonicalIntentBase {
  kind: "ShareRemove";
  object: CanonicalObjectRef;
}

export interface CanonicalFollowAddIntent extends CanonicalIntentBase {
  kind: "FollowAdd";
  subject?: CanonicalActorRef | null;
  targetObject?: CanonicalObjectRef | null;
  activityPubRecipientUri?: string | null;
  activityPubInboxUri?: string | null;
  activityPubFollowersUri?: string | null;
  recursionDepthUsed?: number | null;
}

export interface CanonicalFollowRemoveIntent extends CanonicalIntentBase {
  kind: "FollowRemove";
  subject?: CanonicalActorRef | null;
  targetObject?: CanonicalObjectRef | null;
  activityPubRecipientUri?: string | null;
  activityPubInboxUri?: string | null;
  activityPubFollowersUri?: string | null;
  recursionDepthUsed?: number | null;
}

export interface CanonicalProfileUpdateIntent extends CanonicalIntentBase {
  kind: "ProfileUpdate";
  content: CanonicalContent;
}

export interface CanonicalAccountStateIntent extends CanonicalIntentBase {
  kind: "AccountState";
  state: "active" | "suspended" | "deactivated";
}

export type CanonicalIntent =
  | CanonicalPostCreateIntent
  | CanonicalPostEditIntent
  | CanonicalPostDeleteIntent
  | CanonicalPostInteractionPolicyUpdateIntent
  | CanonicalPollCreateIntent
  | CanonicalPollEditIntent
  | CanonicalPollDeleteIntent
  | CanonicalPollVoteAddIntent
  | CanonicalReactionAddIntent
  | CanonicalReactionRemoveIntent
  | CanonicalShareAddIntent
  | CanonicalShareRemoveIntent
  | CanonicalFollowAddIntent
  | CanonicalFollowRemoveIntent
  | CanonicalProfileUpdateIntent
  | CanonicalAccountStateIntent;

export function isCanonicalPostCreateIntent(intent: CanonicalIntent): intent is CanonicalPostCreateIntent {
  return intent.kind === "PostCreate";
}

export function canonicalReactionIdentityKey(
  intent: Pick<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent, "reactionType" | "reactionContent" | "reactionEmoji">,
): string {
  if (intent.reactionType === "like") {
    return "like";
  }

  const customEmoji = intent.reactionEmoji
    ? [
        intent.reactionEmoji.shortcode.toLowerCase(),
        intent.reactionEmoji.domain ?? "",
        intent.reactionEmoji.emojiId ?? "",
        intent.reactionEmoji.iconUrl ?? "",
      ].join("|")
    : "";

  return [
    "emoji",
    intent.reactionContent ?? "",
    customEmoji,
  ].join(":");
}

export function canonicalFollowTargetIdentityKey(
  intent: Pick<CanonicalFollowAddIntent | CanonicalFollowRemoveIntent, "subject" | "targetObject">,
): string {
  if (intent.targetObject) {
    return canonicalObjectIdentityKey(intent.targetObject);
  }

  if (intent.subject) {
    return canonicalActorIdentityKey(intent.subject);
  }

  return "unknown-follow-target";
}
