/**
 * PollCreateToApProjector
 *
 * Projects a CanonicalPollCreateIntent to an ActivityPub Create{Question}
 * activity per FEP-9967.
 *
 * The Question object carries:
 *   - oneOf/anyOf: option Notes with replies.totalItems vote counts
 *   - endTime + closed: expiry (both fields per interoperability guidance)
 *   - votersCount: Mastodon extension for total unique voters
 *   - updated: ISO timestamp (required by FEP-9967 SHOULD)
 */
import type { CanonicalIntent, CanonicalPollCreateIntent } from "../../canonical/CanonicalIntent.js";
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

export class PollCreateToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollCreate";
  }

  public async project(
    intent: CanonicalPollCreateIntent,
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

    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext(),
      id: `${objectId}#create`,
      type: "Create",
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
