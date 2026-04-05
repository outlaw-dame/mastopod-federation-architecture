import type { CanonicalIntent, CanonicalFollowAddIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { ActivityPubProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialActivityId, buildSocialApMetadata, followTargetKey, socialTargetTopic, toApIri } from "./social-shared.js";

export class FollowAddToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "FollowAdd";
  }

  public async project(
    intent: CanonicalFollowAddIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<ActivityPubProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.activityPubActorUri) {
      return {
        kind: "error",
        code: "AP_FOLLOW_ACTOR_URI_MISSING",
        message: `Cannot project ${canonicalActorIdentityKey(actor)} to ActivityPub without an actor URI.`,
      };
    }

    const subject = await ctx.resolveActorRef(intent.subject);
    const subjectIri = toApIri(subject.activityPubActorUri ?? subject.webId ?? subject.did ?? subject.handle ?? followTargetKey(intent));
    const activity: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: buildSocialActivityId(actor.activityPubActorUri, "Follow", followTargetKey(intent)),
      type: "Follow",
      actor: actor.activityPubActorUri,
      object: subjectIri,
      to: [subjectIri],
      published: intent.createdAt,
    };

    return {
      kind: "success",
      commands: [
        {
          kind: "publishActivity",
          activity,
          targetTopic: socialTargetTopic(intent),
          metadata: buildSocialApMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}
