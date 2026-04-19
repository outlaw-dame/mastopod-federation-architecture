/**
 * PollVoteAddToAtProjector
 *
 * ATProto has no native concept of casting a vote on a poll.
 * This projector emits no commands and records a "none" lossiness warning so
 * the event is acknowledged in the pipeline without producing erroneous output.
 */
import type { CanonicalIntent, CanonicalPollVoteAddIntent } from "../../canonical/CanonicalIntent.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";

export class PollVoteAddToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollVoteAdd";
  }

  public async project(
    _intent: CanonicalPollVoteAddIntent,
    _ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    return {
      kind: "success",
      commands: [],
      lossiness: "none",
      warnings: [
        {
          code: "AT_POLL_VOTE_NOT_SUPPORTED",
          message: "ATProto has no native poll vote record type; vote not projected.",
          lossiness: "none",
        },
      ],
    };
  }
}
