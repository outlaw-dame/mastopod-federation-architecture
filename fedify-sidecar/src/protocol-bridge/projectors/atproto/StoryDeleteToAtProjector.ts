import {
  ACTIVITYPODS_STORY_COLLECTION,
} from "../../../at-adapter/lexicon/ActivityPodsStoryLexicon.js";
import type { CanonicalIntent, CanonicalStoryDeleteIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionCommandMetadata,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { parseAtUri } from "./post-shared.js";

export class StoryDeleteToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "StoryDelete";
  }

  public async project(
    intent: CanonicalStoryDeleteIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REPO_DID_MISSING",
        message: "Cannot delete a story from ATProto without a repository DID.",
      };
    }

    const ref = parseAtUri(intent.object.atUri, actor.did);
    if (!ref || ref.collection !== ACTIVITYPODS_STORY_COLLECTION) {
      return {
        kind: "error",
        code: "AT_STORY_DELETE_URI_MISSING",
        message: "Story deletes require an object ref with an org.activitypods.story.slide AT URI.",
      };
    }

    return {
      kind: "success",
      commands: [
        {
          kind: "deleteRecord",
          collection: ACTIVITYPODS_STORY_COLLECTION,
          repoDid: actor.did,
          rkey: ref.rkey,
          canonicalRefIdHint: intent.object.canonicalObjectId,
          metadata: buildStoryDeleteMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}

function buildStoryDeleteMetadata(intent: CanonicalStoryDeleteIntent): ProjectionCommandMetadata {
  return {
    canonicalIntentId: intent.canonicalIntentId,
    sourceProtocol: intent.sourceProtocol,
    provenance: intent.provenance,
  };
}
