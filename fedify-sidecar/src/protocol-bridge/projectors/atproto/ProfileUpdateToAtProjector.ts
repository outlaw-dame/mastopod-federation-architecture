import {
  buildProfileMediaDraft,
  pickProfileAttachment,
} from "../../profile/BridgeProfileMedia.js";
import type { CanonicalIntent, CanonicalProfileUpdateIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";

export class ProfileUpdateToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ProfileUpdate";
  }

  public async project(
    intent: CanonicalProfileUpdateIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REPO_DID_MISSING",
        message: "Cannot project a profile update to ATProto without a repository DID.",
      };
    }

    const warnings = [...intent.warnings];
    const record: Record<string, unknown> = {
      $type: "app.bsky.actor.profile",
    };
    if (intent.content.title) {
      record["displayName"] = intent.content.title;
    }
    if (intent.content.plaintext) {
      record["description"] = intent.content.plaintext;
    }

    const ownerStableId =
      actor.canonicalAccountId ?? intent.sourceAccountRef.canonicalAccountId ?? actor.did;
    const avatarDraft = buildProfileMediaDraft(
      ownerStableId,
      "avatar",
      pickProfileAttachment(intent.content.attachments, "avatar"),
    );
    const bannerDraft = buildProfileMediaDraft(
      ownerStableId,
      "banner",
      pickProfileAttachment(intent.content.attachments, "banner"),
    );

    if (pickProfileAttachment(intent.content.attachments, "avatar") && !avatarDraft) {
      warnings.push({
        code: "AP_PROFILE_AVATAR_UNSUPPORTED",
        message: "Profile avatar could not be projected to ATProto because it is missing a fetchable image URL or uses an unsupported image type.",
        lossiness: "minor",
      });
    }

    if (pickProfileAttachment(intent.content.attachments, "banner") && !bannerDraft) {
      warnings.push({
        code: "AP_PROFILE_BANNER_UNSUPPORTED",
        message: "Profile banner could not be projected to ATProto because it is missing a fetchable image URL or uses an unsupported image type.",
        lossiness: "minor",
      });
    }

    if (avatarDraft || bannerDraft) {
      record["_bridgeProfileMedia"] = {
        ...(avatarDraft ? { avatar: avatarDraft } : {}),
        ...(bannerDraft ? { banner: bannerDraft } : {}),
      };
    }

    return {
      kind: "success",
      commands: [
        {
          kind: "updateRecord",
          collection: "app.bsky.actor.profile",
          repoDid: actor.did,
          rkey: "self",
          canonicalRefIdHint: actor.canonicalAccountId ?? intent.sourceAccountRef.canonicalAccountId ?? actor.did,
          record,
          metadata: {
            canonicalIntentId: intent.canonicalIntentId,
            sourceProtocol: intent.sourceProtocol,
            provenance: intent.provenance,
          },
        },
      ],
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
}
