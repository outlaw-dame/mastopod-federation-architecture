import type { CanonicalIntent, CanonicalFollowAddIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialMetadata, deriveSocialActorRefId, deriveSocialRkey } from "./social-shared.js";

export class FollowAddToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "FollowAdd";
  }

  public async project(
    intent: CanonicalFollowAddIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_FOLLOW_REPO_DID_MISSING",
        message: "Cannot project a follow to ATProto without a repository DID.",
      };
    }

    const subject = await ctx.resolveActorRef(intent.subject);
    if (!subject.did) {
      return {
        kind: "error",
        code: "AT_FOLLOW_SUBJECT_DID_MISSING",
        message: "ATProto follow projection requires a subject DID.",
      };
    }

    const canonicalRefId = deriveSocialActorRefId("follow", actor, subject);
    return {
      kind: "success",
      commands: [
        {
          kind: "createRecord",
          collection: "app.bsky.graph.follow",
          repoDid: actor.did,
          rkey: deriveSocialRkey(canonicalRefId),
          canonicalRefIdHint: canonicalRefId,
          record: {
            $type: "app.bsky.graph.follow",
            subject: subject.did,
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
