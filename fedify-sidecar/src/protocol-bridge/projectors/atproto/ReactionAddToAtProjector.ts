import type { CanonicalIntent, CanonicalReactionAddIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialMetadata, deriveSocialObjectRefId, deriveSocialRkey } from "./social-shared.js";

export class ReactionAddToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ReactionAdd" && intent.reactionType === "like";
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
    if (!target.atUri || !target.cid) {
      return {
        kind: "error",
        code: "AT_REACTION_TARGET_STRONG_REF_MISSING",
        message: "ATProto like projection requires a target at:// URI and CID.",
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
}
