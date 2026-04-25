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

    const targetObject = intent.targetObject ? await ctx.resolveObjectRef(intent.targetObject) : null;
    const subject = intent.subject ? await ctx.resolveActorRef(intent.subject) : null;
    const followObjectValue = buildFollowObjectValue(intent, targetObject, subject);
    const recipientIri = toApIri(
      intent.activityPubRecipientUri
      ?? subject?.activityPubActorUri
      ?? subject?.webId
      ?? subject?.did
      ?? subject?.handle
      ?? (targetObject
        ? targetObject.activityPubObjectId ?? targetObject.canonicalUrl ?? targetObject.atUri ?? targetObject.canonicalObjectId
        : followTargetKey(intent)),
    );

    if (!targetObject && !subject) {
      return {
        kind: "error",
        code: "AP_FOLLOW_TARGET_MISSING",
        message: `Cannot project follow ${followTargetKey(intent)} to ActivityPub without a target actor or object.`,
      };
    }

    const activity: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: buildSocialActivityId(actor.activityPubActorUri, "Follow", followTargetKey(intent)),
      type: "Follow",
      actor: actor.activityPubActorUri,
      object: followObjectValue,
      to: [recipientIri],
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

function buildFollowObjectValue(
  intent: CanonicalFollowAddIntent,
  targetObject: Awaited<ReturnType<ProjectionContext["resolveObjectRef"]>> | null,
  subject: Awaited<ReturnType<ProjectionContext["resolveActorRef"]>> | null,
): string | Record<string, unknown> {
  if (!targetObject) {
    if (!subject) {
      return toApIri(followTargetKey(intent));
    }

    return toApIri(subject.activityPubActorUri ?? subject.webId ?? subject.did ?? subject.handle ?? followTargetKey(intent));
  }

  const objectIri = toApIri(
    targetObject.activityPubObjectId ?? targetObject.canonicalUrl ?? targetObject.atUri ?? targetObject.canonicalObjectId,
  );
  const objectValue: Record<string, unknown> = { id: objectIri };
  if (intent.activityPubFollowersUri) {
    objectValue["followers"] = intent.activityPubFollowersUri;
  }
  if (intent.activityPubInboxUri) {
    objectValue["inbox"] = intent.activityPubInboxUri;
  }
  if (subject?.activityPubActorUri) {
    objectValue["attributedTo"] = subject.activityPubActorUri;
  }

  return Object.keys(objectValue).length === 1 ? objectIri : objectValue;
}
