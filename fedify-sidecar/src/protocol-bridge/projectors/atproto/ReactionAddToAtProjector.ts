import type { CanonicalIntent, CanonicalReactionAddIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import {
  ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
  buildActivityPodsCustomEmojiField,
} from "../../../at-adapter/lexicon/ActivityPodsEmojiLexicon.js";
import {
  buildSocialMetadata,
  deriveEmojiReactionRefId,
  deriveSocialObjectRefId,
  deriveSocialRkey,
} from "./social-shared.js";

export class ReactionAddToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ReactionAdd";
  }

  public async project(
    intent: CanonicalReactionAddIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REACTION_REPO_DID_MISSING",
        message: "Cannot project a reaction to ATProto without a repository DID.",
      };
    }

    const target = await ctx.resolveObjectRef(intent.object);
    if (!target.atUri) {
      return {
        kind: "error",
        code: "AT_REACTION_TARGET_STRONG_REF_MISSING",
        message: "ATProto reaction projection requires a target at:// URI.",
      };
    }

    if (intent.reactionType === "like") {
      if (!target.cid) {
        return {
          kind: "error",
          code: "AT_REACTION_TARGET_STRONG_REF_MISSING",
          message: "ATProto like projection requires both a target at:// URI and CID.",
        };
      }

      const canonicalRefId = deriveSocialObjectRefId("like", actor, target);
      return {
        kind: "success",
        commands: [
          {
            kind: "createRecord",
            collection: "app.bsky.feed.like",
            repoDid: actor.did,
            rkey: deriveSocialRkey(canonicalRefId),
            canonicalRefIdHint: canonicalRefId,
            record: {
              $type: "app.bsky.feed.like",
              subject: {
                uri: target.atUri,
                cid: target.cid,
              },
              createdAt: intent.createdAt,
            },
            metadata: buildSocialMetadata(intent),
          },
        ],
        lossiness: maxLossiness(intent.warnings),
        warnings: intent.warnings,
      };
    }

    if (!intent.reactionContent) {
      return {
        kind: "error",
        code: "AT_EMOJI_REACTION_CONTENT_MISSING",
        message: "Emoji reaction projection requires normalized reaction content.",
      };
    }

    const canonicalRefId = deriveEmojiReactionRefId(actor, target, intent);
    const encodedEmoji = buildActivityPodsCustomEmojiField(
      intent.reactionEmoji ? [intent.reactionEmoji] : [],
    )?.[0];
    return {
      kind: "success",
      commands: [
        {
          kind: "createRecord",
          collection: ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
          repoDid: actor.did,
          rkey: deriveSocialRkey(canonicalRefId),
          canonicalRefIdHint: canonicalRefId,
          record: {
            $type: ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
            subject: {
              uri: target.atUri,
              ...(target.cid ? { cid: target.cid } : {}),
            },
            reaction: intent.reactionContent,
            ...(encodedEmoji ? { emoji: encodedEmoji } : {}),
            createdAt: intent.createdAt,
          },
          metadata: buildSocialMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}
