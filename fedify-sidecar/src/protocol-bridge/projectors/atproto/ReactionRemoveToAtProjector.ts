import type { CanonicalIntent, CanonicalReactionRemoveIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialMetadata, deriveSocialObjectRefId, deriveSocialRkey } from "./social-shared.js";

export class ReactionRemoveToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ReactionRemove" && intent.reactionType === "like";
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

    const canonicalRefId = deriveSocialObjectRefId("like", actor, target);
    return {
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: "app.bsky.feed.like",
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
