import type { CanonicalIntent, CanonicalShareRemoveIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialMetadata, deriveSocialObjectRefId, deriveSocialRkey } from "./social-shared.js";

export class ShareRemoveToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ShareRemove";
  }

  public async project(
    intent: CanonicalShareRemoveIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_SHARE_REPO_DID_MISSING",
        message: "Cannot project a share removal to ATProto without a repository DID.",
      };
    }

    const target = await ctx.resolveObjectRef(intent.object);
    if (!target.atUri) {
      return {
        kind: "error",
        code: "AT_SHARE_TARGET_URI_MISSING",
        message: "ATProto repost removal requires a target at:// URI.",
      };
    }

    const canonicalRefId = deriveSocialObjectRefId("repost", actor, target);
    return {
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: "app.bsky.feed.repost",
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
