import type { CanonicalIntent, CanonicalPollDeleteIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildPostMetadata, parseAtUri } from "./post-shared.js";

export class PollDeleteToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollDelete";
  }

  public async project(
    intent: CanonicalPollDeleteIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REPO_DID_MISSING",
        message: "Cannot project to ATProto without a repository DID.",
      };
    }

    const primaryRef = parseAtUri(intent.object.atUri, actor.did);
    if (!primaryRef) {
      return {
        kind: "error",
        code: "AT_DELETE_URI_MISSING",
        message: "Poll deletes require the canonical object to resolve to an AT URI.",
      };
    }

    return {
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: primaryRef.collection,
          repoDid: actor.did,
          rkey: primaryRef.rkey,
          canonicalRefIdHint: intent.object.canonicalObjectId,
          metadata: buildPostMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}
