/**
 * PollVoteAddToApProjector
 *
 * Projects a CanonicalPollVoteAddIntent to an ActivityPub Create{Note} vote
 * activity per FEP-9967.
 *
 * A vote is a Create wrapping a Note that:
 *   - has `name` equal to the chosen option text
 *   - has `inReplyTo` pointing to the Question object
 *   - has `to` set to the poll author only (not Public)
 *   - has NO `content` property (distinguishes it from a reply)
 *
 * Delivery: sent only to the poll author (anonymous polls MUST NOT deliver to others).
 */
import type { CanonicalIntent, CanonicalPollVoteAddIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  ActivityPubProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { apTargetTopic, buildPostMetadata, resolveApObjectId, resolveOptionalApObjectId } from "./post-shared.js";

export class PollVoteAddToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollVoteAdd";
  }

  public async project(
    intent: CanonicalPollVoteAddIntent,
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

    const voteId = resolveApObjectId(intent.object);
    const pollId = resolveOptionalApObjectId(intent.pollRef) ?? resolveApObjectId(intent.pollRef);

    // Votes are addressed directly to the poll author — the projector does not
    // know the author's actor URI from the intent alone, so we use the pollId
    // as the `to` target.  The AP delivery layer resolves the actual inbox from
    // the Question object's attributedTo field.
    const voteNote: Record<string, unknown> = {
      id: voteId,
      type: "Note",
      attributedTo: actorId,
      name: intent.optionName,
      inReplyTo: pollId,
      to: pollId, // addressed to the poll (delivery layer resolves to author)
    };
    // NOTE: no `content` property — FEP-9967 requirement for vote identification

    const activity: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${voteId}#create`,
      type: "Create",
      actor: actorId,
      object: voteNote,
      published: intent.createdAt,
      to: pollId,
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
