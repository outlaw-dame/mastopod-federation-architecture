import type { CanonicalIntent, CanonicalReactionRemoveIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { ACTIVITYPODS_EMOJI_REACTION_COLLECTION } from "../../../at-adapter/lexicon/ActivityPodsEmojiLexicon.js";
import {
  buildSocialMetadata,
  deriveEmojiReactionRefId,
  deriveSocialObjectRefId,
  deriveSocialRkey,
} from "./social-shared.js";

export class ReactionRemoveToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ReactionRemove";
  }

  public async project(
    intent: CanonicalReactionRemoveIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REACTION_REPO_DID_MISSING",
        message: "Cannot project a reaction removal to ATProto without a repository DID.",
      };
    }

    const target = await ctx.resolveObjectRef(intent.object);
    if (!target.atUri) {
      return {
        kind: "error",
        code: "AT_REACTION_TARGET_URI_MISSING",
        message: "ATProto like removal requires a target at:// URI.",
      };
    }

    const canonicalRefId = intent.reactionType === "like"
      ? deriveSocialObjectRefId("like", actor, target)
      : deriveEmojiReactionRefId(actor, target, intent);
    return {
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: intent.reactionType === "like"
            ? "app.bsky.feed.like"
            : ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
          repoDid: actor.did,
          rkey: deriveSocialRkey(canonicalRefId),
          canonicalRefIdHint: canonicalRefId,
          metadata: buildSocialMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}
