import { createHash } from "node:crypto";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { canonicalObjectIdentityKey } from "../../canonical/CanonicalObjectRef.js";
import {
  canonicalReactionIdentityKey,
} from "../../canonical/CanonicalIntent.js";
import type {
  CanonicalFollowAddIntent,
  CanonicalFollowRemoveIntent,
  CanonicalReactionAddIntent,
  CanonicalReactionRemoveIntent,
  CanonicalShareAddIntent,
  CanonicalShareRemoveIntent,
} from "../../canonical/CanonicalIntent.js";
import type { ProjectionCommandMetadata } from "../../ports/ProtocolBridgePorts.js";

type SocialIntent =
  | CanonicalReactionAddIntent
  | CanonicalReactionRemoveIntent
  | CanonicalShareAddIntent
  | CanonicalShareRemoveIntent
  | CanonicalFollowAddIntent
  | CanonicalFollowRemoveIntent;

export function buildSocialMetadata(intent: SocialIntent): ProjectionCommandMetadata {
  return {
    canonicalIntentId: intent.canonicalIntentId,
    sourceProtocol: intent.sourceProtocol,
    provenance: intent.provenance,
  };
}

export function deriveSocialObjectRefId(
  action: "like" | "repost",
  actor: SocialIntent["sourceAccountRef"],
  object: CanonicalReactionAddIntent["object"] | CanonicalShareAddIntent["object"],
): string {
  return createHash("sha256")
    .update(`${action}:${canonicalActorIdentityKey(actor)}:${canonicalObjectIdentityKey(object)}`)
    .digest("hex");
}

export function deriveSocialActorRefId(
  action: "follow",
  actor: SocialIntent["sourceAccountRef"],
  subject: NonNullable<CanonicalFollowAddIntent["subject"]>,
): string {
  return createHash("sha256")
    .update(`${action}:${canonicalActorIdentityKey(actor)}:${canonicalActorIdentityKey(subject)}`)
    .digest("hex");
}

export function deriveSocialRkey(canonicalRefId: string): string {
  return canonicalRefId.slice(0, 13);
}

export function deriveEmojiReactionRefId(
  actor: SocialIntent["sourceAccountRef"],
  object: CanonicalReactionAddIntent["object"],
  reaction: Pick<CanonicalReactionAddIntent | CanonicalReactionRemoveIntent, "reactionType" | "reactionContent" | "reactionEmoji">,
): string {
  return createHash("sha256")
    .update(
      `emojiReaction:${canonicalActorIdentityKey(actor)}:${canonicalObjectIdentityKey(object)}:${canonicalReactionIdentityKey(reaction)}`,
    )
    .digest("hex");
}
