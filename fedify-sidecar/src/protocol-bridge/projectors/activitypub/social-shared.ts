import { createHash } from "node:crypto";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { canonicalFollowTargetIdentityKey } from "../../canonical/CanonicalIntent.js";
import { canonicalReactionIdentityKey } from "../../canonical/CanonicalIntent.js";
import { canonicalObjectIdentityKey } from "../../canonical/CanonicalObjectRef.js";
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

export function buildSocialApMetadata(intent: SocialIntent): ProjectionCommandMetadata {
  return {
    canonicalIntentId: intent.canonicalIntentId,
    sourceProtocol: intent.sourceProtocol,
    provenance: intent.provenance,
  };
}

export function buildSocialActivityId(
  actorId: string,
  action: "Like" | "EmojiReact" | "Announce" | "Follow",
  targetKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${actorId}:${action}:${targetKey}`)
    .digest("hex")
    .slice(0, 24);

  if (actorId.startsWith("http://") || actorId.startsWith("https://")) {
    return `${actorId.replace(/\/+$/, "")}/__bridge/${action.toLowerCase()}/${digest}`;
  }

  return `urn:bridge:${action.toLowerCase()}:${digest}`;
}

export function socialTargetTopic(intent: SocialIntent): "ap.atproto-ingress.v1" | "ap.outbound.v1" {
  return intent.provenance.originProtocol === "atproto" ? "ap.atproto-ingress.v1" : "ap.outbound.v1";
}

export function reactionTargetKey(intent: CanonicalReactionAddIntent | CanonicalReactionRemoveIntent): string {
  return `${canonicalObjectIdentityKey(intent.object)}:${canonicalReactionIdentityKey(intent)}`;
}

export function shareTargetKey(intent: CanonicalShareAddIntent | CanonicalShareRemoveIntent): string {
  return canonicalObjectIdentityKey(intent.object);
}

export function followTargetKey(intent: CanonicalFollowAddIntent | CanonicalFollowRemoveIntent): string {
  return canonicalFollowTargetIdentityKey(intent);
}

export function toApIri(value: string): string {
  return /^https?:\/\//.test(value) || value.startsWith("urn:") || value.startsWith("did:")
    ? value
    : `urn:canonical:${encodeURIComponent(value)}`;
}
