import type {
  CanonicalIntent,
  CanonicalPostInteractionPolicyUpdateIntent,
} from "../../canonical/CanonicalIntent.js";
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
  buildApInteractionPolicy,
  buildPostMetadata,
  resolveApObjectId,
} from "./post-shared.js";

/**
 * Projects a `PostInteractionPolicyUpdate` canonical intent to an ActivityPub
 * `Update` activity that carries a minimal Note/Article stub containing only
 * the updated `interactionPolicy` object.
 *
 * The stub intentionally omits post content (title, body, attachments) that is
 * not available in the intent.  Receivers that need the full Note can
 * dereference the `object.id`.  GoToSocial and other servers implementing the
 * GoToSocial interaction policy vocabulary will apply the policy from the stub
 * without fetching the full object.
 *
 * AP projection rules for absent policy fields:
 *   canReply absent → defaults to "everyone" (no restriction)
 *   canQuote absent → defaults to "everyone" (no restriction)
 */
export class PostInteractionPolicyUpdateToApProjector
  implements CanonicalProjector<ActivityPubProjectionCommand>
{
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostInteractionPolicyUpdate";
  }

  public async project(
    intent: CanonicalPostInteractionPolicyUpdateIntent,
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
    // Interaction policy updates are always public metadata (the policy itself
    // is not sensitive; who can reply/quote does not convey post content).
    const audience = buildAudience(actorId, "public", []);

    const interactionPolicy = buildApInteractionPolicy(
      {
        canReply: intent.canReply ?? "everyone",
        canQuote: intent.canQuote ?? "everyone",
      },
      actorId,
    );

    // Minimal object stub — receivers that need full content dereference id.
    const object: Record<string, unknown> = {
      id: objectId,
      // We don't know whether the original was a Note or Article; Note is the
      // safe default as it is the most common type and always valid.
      type: "Note",
      attributedTo: actorId,
      interactionPolicy,
    };

    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext({}),
      id: `${objectId}#interaction-policy-update-${intent.canonicalIntentId.slice(0, 12)}`,
      type: "Update",
      actor: actorId,
      object,
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
