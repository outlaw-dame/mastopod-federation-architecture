import { canonicalBlocksToHtml } from "../../text/CanonicalBlocksToHtml.js";
import type { CanonicalIntent, CanonicalProfileUpdateIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  ActivityPubProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { pickProfileAttachment } from "../../profile/BridgeProfileMedia.js";
import { buildAudience, canonicalFacetsToApTags, escapeHtml } from "./PostCreateToApProjector.js";
import { buildApActivityContext } from "./post-shared.js";

export class ProfileUpdateToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "ProfileUpdate";
  }

  public async project(
    intent: CanonicalProfileUpdateIntent,
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

    const warnings = [...intent.warnings];
    const audience = buildAudience(actorId, "public", []);
    const summaryHtml = intent.content.blocks.length > 0
      ? canonicalBlocksToHtml(intent.content.blocks)
      : intent.content.plaintext
        ? `<p>${escapeHtml(intent.content.plaintext).replace(/\n/g, "<br>")}</p>`
        : undefined;
    const object: Record<string, unknown> = {
      id: actorId,
      type: "Person",
      updated: intent.createdAt,
      to: audience.to,
      cc: audience.cc,
    };
    if (intent.content.title) {
      object["name"] = intent.content.title;
    }
    if (summaryHtml) {
      object["summary"] = summaryHtml;
    }
    if (intent.content.externalUrl) {
      object["url"] = intent.content.externalUrl;
    }
    const tag = canonicalFacetsToApTags(intent.content.facets, null, intent.content.customEmojis ?? []);
    if (tag.length > 0) {
      object["tag"] = tag;
    }

    const avatar = await toActivityPubImage(
      pickProfileAttachment(intent.content.attachments, "avatar"),
      actor.did ?? null,
      ctx,
    );
    if (avatar) {
      object["icon"] = avatar;
    } else if (pickProfileAttachment(intent.content.attachments, "avatar")) {
      warnings.push({
        code: "AT_PROFILE_AVATAR_URL_UNRESOLVED",
        message: "ATProto avatar blob could not be mapped to a fetchable ActivityPub icon URL.",
        lossiness: "minor",
      });
    }

    const banner = await toActivityPubImage(
      pickProfileAttachment(intent.content.attachments, "banner"),
      actor.did ?? null,
      ctx,
    );
    if (banner) {
      object["image"] = banner;
    } else if (pickProfileAttachment(intent.content.attachments, "banner")) {
      warnings.push({
        code: "AT_PROFILE_BANNER_URL_UNRESOLVED",
        message: "ATProto banner blob could not be mapped to a fetchable ActivityPub image URL.",
        lossiness: "minor",
      });
    }

    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext({ includeCustomEmojis: (intent.content.customEmojis ?? []).length > 0 }),
      id: `${actorId.replace(/\/+$/, "")}/#profile-update-${intent.canonicalIntentId.slice(0, 12)}`,
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
          targetTopic: intent.provenance.originProtocol === "atproto" ? "ap.atproto-ingress.v1" : "ap.outbound.v1",
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

async function toActivityPubImage(
  attachment: CanonicalProfileUpdateIntent["content"]["attachments"][number] | null,
  did: string | null,
  ctx: ProjectionContext,
): Promise<Record<string, unknown> | null> {
  if (!attachment) {
    return null;
  }

  const url = attachment.url ?? (did && attachment.cid && ctx.resolveBlobUrl
    ? await ctx.resolveBlobUrl(did, attachment.cid)
    : null);
  if (!url) {
    return null;
  }

  return {
    type: "Image",
    url,
    ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
    ...(attachment.alt ? { name: attachment.alt } : {}),
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
  };
}
