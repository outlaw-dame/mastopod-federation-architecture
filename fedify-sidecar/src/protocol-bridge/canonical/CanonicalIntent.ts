import type { CanonicalActorRef } from "./CanonicalActorRef.js";
import type { CanonicalContent, CanonicalCustomEmoji } from "./CanonicalContent.js";
import type { CanonicalIntentBase } from "./CanonicalEnvelope.js";
import type { CanonicalObjectRef } from "./CanonicalObjectRef.js";

export type CanonicalIntentKind =
  | "PostCreate"
  | "PostEdit"
  | "PostDelete"
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
}

export interface CanonicalPostEditIntent extends CanonicalIntentBase {
  kind: "PostEdit";
  object: CanonicalObjectRef;
  content: CanonicalContent;
  inReplyTo?: CanonicalObjectRef | null;
  /** FEP-7888 / FEP-11dd: root of the reply thread, used as the AP `context` property. */
  replyRoot?: CanonicalObjectRef | null;
  quoteOf?: CanonicalObjectRef | null;
}

export interface CanonicalPostDeleteIntent extends CanonicalIntentBase {
  kind: "PostDelete";
  object: CanonicalObjectRef;
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
  subject: CanonicalActorRef;
}

export interface CanonicalFollowRemoveIntent extends CanonicalIntentBase {
  kind: "FollowRemove";
  subject: CanonicalActorRef;
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
