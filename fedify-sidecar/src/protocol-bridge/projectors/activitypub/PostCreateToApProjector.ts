import type { CanonicalAttachment, CanonicalFacet } from "../../canonical/CanonicalContent.js";
import type { CanonicalIntent, CanonicalPostCreateIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { canonicalBlocksToHtml } from "../../text/CanonicalBlocksToHtml.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  ActivityPubProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import {
  DEFAULT_ACTIVITYPUB_PROJECTION_POLICY,
  type ActivityPubProjectionPolicy,
} from "./ActivityPubProjectionPolicy.js";
import {
  buildApLinkPreviewCard,
  apTargetTopic,
  buildApLinkPreviewIcon,
  buildPostMetadata,
  PUBLIC_AUDIENCE,
  resolveApObjectId,
  resolveOptionalApObjectId,
} from "./post-shared.js";

export class PostCreateToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public constructor(
    private readonly policy: ActivityPubProjectionPolicy = DEFAULT_ACTIVITYPUB_PROJECTION_POLICY,
  ) {}

  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostCreate";
  }

  public async project(
    intent: CanonicalPostCreateIntent,
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
    const html = intent.content.blocks.length > 0
      ? canonicalBlocksToHtml(intent.content.blocks)
      : `<p>${escapeHtml(intent.content.plaintext).replace(/\n/g, "<br>")}</p>`;
    const tag = canonicalFacetsToApTags(intent.content.facets);
    const attachment = canonicalAttachmentsToApAttachments(intent.content.attachments);
    const linkPreviewCard =
      intent.content.kind === "note" && this.policy.noteLinkPreviewMode !== "disabled"
        ? buildApLinkPreviewCard(intent.content.linkPreview)
        : null;
    const mentionRecipients = canonicalMentionRecipients(intent.content.facets);
    const audience = buildAudience(actorId, intent.visibility, mentionRecipients);
    const object: Record<string, unknown> = {
      id: objectId,
      type: intent.content.kind === "article" ? "Article" : "Note",
      attributedTo: actorId,
      content: html,
      published: intent.createdAt,
      to: audience.to,
      cc: audience.cc,
      url: intent.content.externalUrl ?? intent.object.canonicalUrl ?? objectId,
    };

    if (intent.content.title) {
      object["name"] = intent.content.title;
    }
    if (intent.content.summary) {
      object["summary"] = intent.content.summary;
    }
    const previewIcon = intent.content.kind === "article"
      ? buildApLinkPreviewIcon(intent.content.linkPreview)
      : null;
    if (previewIcon) {
      object["icon"] = previewIcon;
    }
    if (linkPreviewCard && this.policy.noteLinkPreviewMode === "attachment_and_preview") {
      object["preview"] = linkPreviewCard;
    }
    const inReplyTo = resolveOptionalApObjectId(intent.inReplyTo);
    if (inReplyTo) {
      object["inReplyTo"] = inReplyTo;
    }
    if (tag.length > 0) {
      object["tag"] = tag;
    }
    if (attachment.length > 0 || linkPreviewCard) {
      object["attachment"] = linkPreviewCard
        ? [...attachment, linkPreviewCard]
        : attachment;
    }

    const activity: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${objectId}#create`,
      type: "Create",
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

export function canonicalFacetsToApTags(facets: readonly CanonicalFacet[]): Array<Record<string, unknown>> {
  return facets.flatMap((facet) => {
    switch (facet.type) {
      case "mention":
        return facet.target.activityPubActorUri
          ? [{
              type: "Mention",
              href: facet.target.activityPubActorUri,
              name: facet.label,
            }]
          : [];
      case "tag":
        return [{
          type: "Hashtag",
          name: facet.tag.startsWith("#") ? facet.tag : `#${facet.tag}`,
        }];
      case "link":
        return [];
    }
  });
}

export function canonicalAttachmentsToApAttachments(
  attachments: readonly CanonicalAttachment[],
): Array<Record<string, unknown>> {
  return attachments.map((attachment) => ({
    type: attachment.mediaType.startsWith("image/")
      ? "Image"
      : attachment.mediaType.startsWith("video/")
        ? "Video"
        : attachment.mediaType.startsWith("audio/")
          ? "Audio"
          : "Document",
    mediaType: attachment.mediaType,
    url: attachment.url ?? attachment.cid ?? attachment.attachmentId,
    name: attachment.alt ?? undefined,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
    blurhash: attachment.blurhash ?? undefined,
  }));
}

export function canonicalMentionRecipients(facets: readonly CanonicalFacet[]): string[] {
  const recipients = new Set<string>();

  for (const facet of facets) {
    if (facet.type !== "mention") {
      continue;
    }
    const actorUri = facet.target.activityPubActorUri?.trim();
    if (actorUri) {
      recipients.add(actorUri);
    }
  }

  return [...recipients];
}

export function buildAudience(
  actorId: string,
  visibility: CanonicalPostCreateIntent["visibility"],
  mentionRecipients: readonly string[],
) {
  const followers = `${actorId}/followers`;
  const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

  switch (visibility) {
    case "public":
      return { to: [PUBLIC_AUDIENCE], cc: unique([followers, ...mentionRecipients]) };
    case "unlisted":
      return { to: [followers], cc: unique([PUBLIC_AUDIENCE, ...mentionRecipients]) };
    case "followers":
      return { to: [followers], cc: unique(mentionRecipients) };
    case "direct":
    case "unknown":
      return { to: unique(mentionRecipients), cc: [] as string[] };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
