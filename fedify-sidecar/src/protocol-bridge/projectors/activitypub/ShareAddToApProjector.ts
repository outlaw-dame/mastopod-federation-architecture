import type { CanonicalIntent, CanonicalShareAddIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type { ActivityPubProjectionCommand, ProjectionContext, ProjectionResult } from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildSocialActivityId, buildSocialApMetadata, shareTargetKey, socialTargetTopic, toApIri } from "./social-shared.js";

export class ShareAddToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ShareAdd";
  }

  public async project(
    intent: CanonicalShareAddIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<ActivityPubProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.activityPubActorUri) {
      return {
        kind: "error",
        code: "AP_SHARE_ACTOR_URI_MISSING",
        message: `Cannot project ${canonicalActorIdentityKey(actor)} to ActivityPub without an actor URI.`,
      };
    }

    const target = await ctx.resolveObjectRef(intent.object);
    const targetIri = toApIri(target.activityPubObjectId ?? target.canonicalUrl ?? target.atUri ?? target.canonicalObjectId);
    const activity: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: buildSocialActivityId(actor.activityPubActorUri, "Announce", shareTargetKey(intent)),
      type: "Announce",
      actor: actor.activityPubActorUri,
      object: targetIri,
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
