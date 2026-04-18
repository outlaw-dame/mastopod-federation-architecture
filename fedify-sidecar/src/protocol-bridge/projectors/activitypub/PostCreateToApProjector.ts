import type { CanonicalAttachment, CanonicalCustomEmoji, CanonicalFacet } from "../../canonical/CanonicalContent.js";
import type { CanonicalIntent, CanonicalPostCreateIntent } from "../../canonical/CanonicalIntent.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { canonicalBlocksToHtml } from "../../text/CanonicalBlocksToHtml.js";
import { linkifyHashtagsInHtml } from "../../../utils/markdown.js";
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
  buildApActivityContext,
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

    const actorOrigin = safeOrigin(actorId);
    const objectId = resolveApObjectId(intent.object);
    const rawHtml = intent.content.blocks.length > 0
      ? canonicalBlocksToHtml(intent.content.blocks)
      : `<p>${escapeHtml(intent.content.plaintext).replace(/\n/g, "<br>")}</p>`;
    const html = actorOrigin ? linkifyHashtagsInHtml(rawHtml, actorOrigin) : rawHtml;
    const customEmojis = intent.content.customEmojis ?? [];
    const tag = canonicalFacetsToApTags(intent.content.facets, actorOrigin, customEmojis);
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
    // FEP-7888 / FEP-11dd: thread root as AP context.
    // The root Note is resolvable and carries attributedTo, satisfying FEP-11dd ownership.
    const apContext = resolveOptionalApObjectId(intent.replyRoot);
    if (apContext) {
      object["context"] = apContext;
    }
    // FEP-7458: advertise the replies collection so consumers can verify reply membership.
    // ActivityPods creates and serves this collection lazily at ${noteId}/replies.
    object["replies"] = `${objectId}/replies`;
    const quoteUrl = resolveOptionalApObjectId(intent.quoteOf);
    if (quoteUrl) {
      object["quoteUrl"] = quoteUrl;
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
      "@context": buildApActivityContext({ includeCustomEmojis: customEmojis.length > 0 }),
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

export function canonicalFacetsToApTags(
  facets: readonly CanonicalFacet[],
  actorOrigin?: string | null,
  customEmojis: readonly CanonicalCustomEmoji[] = [],
): Array<Record<string, unknown>> {
  const structuralTags = facets.flatMap((facet) => {
    switch (facet.type) {
      case "mention":
        return facet.target.activityPubActorUri
          ? [{
              type: "Mention",
              href: facet.target.activityPubActorUri,
              name: facet.label,
            }]
          : [];
      case "tag": {
        const nameWithHash = facet.tag.startsWith("#") ? facet.tag : `#${facet.tag}`;
        const tagBody = nameWithHash.slice(1).toLowerCase();
        const entry: Record<string, unknown> = {
          type: "Hashtag",
          name: nameWithHash,
        };
        if (actorOrigin) {
          entry["href"] = `${actorOrigin}/tags/${encodeURIComponent(tagBody)}`;
        }
        return [entry];
      }
      case "link":
        return [];
    }
  });

  const emojiTags = customEmojis
    .filter((emoji) => typeof emoji.iconUrl === "string" && emoji.iconUrl.trim().length > 0)
    .map((emoji) => ({
      type: "Emoji",
      name: emoji.shortcode,
      ...(emoji.emojiId ? { id: emoji.emojiId } : {}),
      ...(emoji.updatedAt ? { updated: emoji.updatedAt } : {}),
      ...(emoji.alternateName ? { alternateName: emoji.alternateName } : {}),
      icon: {
        type: "Image",
        url: emoji.iconUrl,
        ...(emoji.mediaType ? { mediaType: emoji.mediaType } : {}),
      },
    }));

  return [...structuralTags, ...emojiTags];
}

export function safeOriginFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Module-local alias used within this file.
const safeOrigin = safeOriginFromUrl;

export function canonicalAttachmentsToApAttachments(
  attachments: readonly CanonicalAttachment[],
): Array<Record<string, unknown>> {
  return attachments.map((attachment) => {
    const primaryUrl = attachment.url ?? attachment.attachmentId;
    const ipfsUrl = toIpfsUrl(attachment.cid);

    // FEP-1311: when both an HTTP URL and an IPFS CID are available, emit both
    // as a url array so consumers can verify content integrity and fetch via IPFS.
    const urlValue: unknown = primaryUrl && ipfsUrl
      ? [primaryUrl, ipfsUrl]
      : primaryUrl ?? ipfsUrl ?? attachment.attachmentId;

    return {
      type: activityPubMediaTypeForAttachment(attachment.mediaType),
      mediaType: attachment.mediaType,
      url: urlValue,
      name: attachment.alt ?? undefined,
      size: attachment.byteSize ?? undefined,
      duration: attachment.duration ?? undefined,
      digestMultibase: attachment.digestMultibase ?? undefined,
      width: attachment.width ?? undefined,
      height: attachment.height ?? undefined,
      focalPoint: attachment.focalPoint ?? undefined,
      blurhash: attachment.blurhash ?? undefined,
    };
  });
}

function activityPubMediaTypeForAttachment(mediaType: string): "Image" | "Video" | "Audio" | "Document" {
  if (mediaType.startsWith("image/")) {
    return "Image";
  }
  if (mediaType.startsWith("video/")) {
    return "Video";
  }
  if (mediaType.startsWith("audio/")) {
    return "Audio";
  }
  return "Document";
}

function toIpfsUrl(cid: string | null | undefined): string | null {
  if (!cid || cid.trim().length === 0) {
    return null;
  }

  return `ipfs://${cid}`;
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
