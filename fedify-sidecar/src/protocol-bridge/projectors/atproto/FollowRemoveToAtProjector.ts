import type { CanonicalIntent, CanonicalFollowRemoveIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialMetadata, deriveSocialActorRefId, deriveSocialRkey } from "./social-shared.js";

export class FollowRemoveToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "FollowRemove";
  }

  public async project(
    intent: CanonicalFollowRemoveIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_FOLLOW_REPO_DID_MISSING",
        message: "Cannot project a follow removal to ATProto without a repository DID.",
      };
    }

    const subject = await ctx.resolveActorRef(intent.subject);
    if (!subject.did) {
      return {
        kind: "error",
        code: "AT_FOLLOW_SUBJECT_DID_MISSING",
        message: "ATProto follow removal requires a subject DID.",
      };
    }

    const canonicalRefId = deriveSocialActorRefId("follow", actor, subject);
    return {
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: "app.bsky.graph.follow",
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
