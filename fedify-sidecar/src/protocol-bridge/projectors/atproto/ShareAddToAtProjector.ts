import type { CanonicalIntent, CanonicalShareAddIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { AtProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialMetadata, deriveSocialObjectRefId, deriveSocialRkey } from "./social-shared.js";

export class ShareAddToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ShareAdd";
  }

  public async project(
    intent: CanonicalShareAddIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_SHARE_REPO_DID_MISSING",
        message: "Cannot project a share to ATProto without a repository DID.",
      };
    }

    const target = await ctx.resolveObjectRef(intent.object);
    if (!target.atUri || !target.cid) {
      return {
        kind: "error",
        code: "AT_SHARE_TARGET_STRONG_REF_MISSING",
        message: "ATProto repost projection requires a target at:// URI and CID.",
      };
    }

    const canonicalRefId = deriveSocialObjectRefId("repost", actor, target);
    return {
      kind: "success",
      commands: [
        {
          kind: "createRecord",
          collection: "app.bsky.feed.repost",
          repoDid: actor.did,
          rkey: deriveSocialRkey(canonicalRefId),
          canonicalRefIdHint: canonicalRefId,
          record: {
            $type: "app.bsky.feed.repost",
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
