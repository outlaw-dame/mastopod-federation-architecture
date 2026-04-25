import type { CanonicalIntent, CanonicalReactionAddIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { ActivityPubProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildApActivityContext } from "./post-shared.js";
import { buildSocialActivityId, buildSocialApMetadata, reactionTargetKey, socialTargetTopic, toApIri } from "./social-shared.js";

type ProjectedReactionPayload = {
  activityType: "Like" | "EmojiReact";
  content: string | null;
  tag: Array<Record<string, unknown>>;
};

export class ReactionAddToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ReactionAdd";
  }

  public async project(
    intent: CanonicalReactionAddIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<ActivityPubProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.activityPubActorUri) {
      return {
        kind: "error",
        code: "AP_REACTION_ACTOR_URI_MISSING",
        message: `Cannot project ${canonicalActorIdentityKey(actor)} to ActivityPub without an actor URI.`,
      };
    }

    const projectedReaction = resolveProjectedReaction(intent);
    if (!projectedReaction) {
      return {
        kind: "error",
        code: "AP_REACTION_CONTENT_MISSING",
        message: "Emoji reactions require normalized reaction content before they can be projected to ActivityPub.",
      };
    }

    const target = await ctx.resolveObjectRef(intent.object);
    const targetIri = toApIri(target.activityPubObjectId ?? target.canonicalUrl ?? target.atUri ?? target.canonicalObjectId);
    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext({
        includeCustomEmojis: projectedReaction.tag.length > 0,
        includeEmojiReact: projectedReaction.activityType === "EmojiReact",
      }),
      id: buildSocialActivityId(actor.activityPubActorUri, projectedReaction.activityType, reactionTargetKey(intent)),
      type: projectedReaction.activityType,
      actor: actor.activityPubActorUri,
      object: targetIri,
      published: intent.createdAt,
    };
    if (projectedReaction.content) {
      activity["content"] = projectedReaction.content;
    }
    if (projectedReaction.tag.length > 0) {
      activity["tag"] = projectedReaction.tag;
    }

    return {
      kind: "success",
      commands: [
        {
          kind: "publishActivity",
          activity,
          targetTopic: socialTargetTopic(intent),
          metadata: buildSocialApMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}

function resolveProjectedReaction(intent: CanonicalReactionAddIntent): ProjectedReactionPayload | null {
  if (intent.reactionType !== "emoji") {
    return {
      activityType: "Like",
      content: null,
      tag: [],
    };
  }

  const content = typeof intent.reactionContent === "string" ? intent.reactionContent.trim() : "";
  if (!content) {
    return null;
  }

  const isShortcode = /^:[A-Za-z0-9_+-]{1,64}:$/.test(content);
  if (!isShortcode) {
    return {
      activityType: "EmojiReact",
      content,
      tag: [],
    };
  }

  if (!intent.reactionEmoji?.iconUrl) {
    return {
      activityType: "Like",
      content,
      tag: [],
    };
  }

  return {
    activityType: "EmojiReact",
    content,
    tag: [
      {
        type: "Emoji",
        name: intent.reactionEmoji.shortcode,
        ...(intent.reactionEmoji.emojiId ? { id: intent.reactionEmoji.emojiId } : {}),
        ...(intent.reactionEmoji.updatedAt ? { updated: intent.reactionEmoji.updatedAt } : {}),
        ...(intent.reactionEmoji.alternateName ? { alternateName: intent.reactionEmoji.alternateName } : {}),
        icon: {
          type: "Image",
          url: intent.reactionEmoji.iconUrl,
          ...(intent.reactionEmoji.mediaType ? { mediaType: intent.reactionEmoji.mediaType } : {}),
        },
      },
    ],
  };
}
