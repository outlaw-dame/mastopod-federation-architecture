/**
 * PollEditToApProjector
 *
 * Projects a CanonicalPollEditIntent to an ActivityPub Update{Question}
 * activity per FEP-9967.
 *
 * Update activities are published when:
 *   - The poll author changed options or voting mode (vote counts reset)
 *   - A vote was received and the author broadcasts updated totalItems counts
 */
import type { CanonicalIntent, CanonicalPollEditIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  ActivityPubProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildAudience } from "./PostCreateToApProjector.js";
import {
  apTargetTopic,
  buildApActivityContext,
  buildPostMetadata,
  resolveApObjectId,
} from "./post-shared.js";
import { buildPollQuestionObject } from "./poll-shared.js";

export class PollEditToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollEdit";
  }

  public async project(
    intent: CanonicalPollEditIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<ActivityPubProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    const actorId = actor.activityPubActorUri;
    if (!actorId) {
      return {
        kind: "error",
        code: "AP_ACTOR_URI_MISSING",
        message: `Cannot project ${canonicalActorIdentityKey(actor)} to ActivityPub without an actor URI.`,
      };
    }

    const objectId = resolveApObjectId(intent.object);
    const audience = buildAudience(actorId, intent.visibility, []);
    const questionObject = buildPollQuestionObject(intent, actorId, objectId, audience);
    // FEP-9967: Update should set updated to current time.
    questionObject["updated"] = intent.createdAt;

    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext(),
      id: `${objectId}#update-${intent.canonicalIntentId.slice(0, 12)}`,
      type: "Update",
      actor: actorId,
      object: questionObject,
      published: intent.createdAt,
      to: audience.to,
      cc: audience.cc,
    };

    return {
      kind: "success",
      commands: [
        {
          kind: "publishActivity",
          activity,
          targetTopic: apTargetTopic(intent),
          metadata: buildPostMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}
