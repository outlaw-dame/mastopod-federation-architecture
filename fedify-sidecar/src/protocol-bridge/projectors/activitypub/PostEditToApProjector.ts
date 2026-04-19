import type { CanonicalAttachment, CanonicalFacet } from "../../canonical/CanonicalContent.js";
import type { CanonicalIntent, CanonicalPostEditIntent } from "../../canonical/CanonicalIntent.js";
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
  buildAudience,
  canonicalAttachmentsToApAttachments,
  canonicalFacetsToApTags,
  canonicalMentionRecipients,
  escapeHtml,
  safeOriginFromUrl,
} from "./PostCreateToApProjector.js";
import {
  buildApArticlePreview,
  buildApInteractionPolicy,
  buildApLinkPreviewCard,
  apTargetTopic,
  buildApActivityContext,
  buildApLinkPreviewIcon,
  buildPostMetadata,
  resolveApObjectId,
  resolveOptionalApObjectId,
} from "./post-shared.js";

export class PostEditToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public constructor(
    private readonly policy: ActivityPubProjectionPolicy = DEFAULT_ACTIVITYPUB_PROJECTION_POLICY,
  ) {}

  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostEdit";
  }

  public async project(
    intent: CanonicalPostEditIntent,
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

    const actorOrigin = safeOriginFromUrl(actorId);
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
      updated: intent.createdAt,
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
    const articlePreview = intent.content.kind === "article"
      ? buildApArticlePreview({
          title: intent.content.title,
          summary: intent.content.summary,
          linkPreview: intent.content.linkPreview,
          attributedTo: actorId,
          updated: intent.createdAt,
          tag,
        })
      : null;
    if (previewIcon) {
      object["icon"] = previewIcon;
    }
    if (articlePreview) {
      object["preview"] = articlePreview;
    }
    if (linkPreviewCard && this.policy.noteLinkPreviewMode === "attachment_and_preview") {
      object["preview"] = linkPreviewCard;
    }
    const inReplyTo = resolveOptionalApObjectId(intent.inReplyTo);
    if (inReplyTo) {
      object["inReplyTo"] = inReplyTo;
    }
    // FEP-7888 / FEP-11dd: thread root as AP context.
    const apContext = resolveOptionalApObjectId(intent.replyRoot);
    if (apContext) {
      object["context"] = apContext;
    }
    // FEP-7458: advertise the replies collection so consumers can verify reply membership.
    // ActivityPods creates and serves this collection lazily at ${noteId}/replies.
    object["replies"] = `${objectId}/replies`;
    const quoteId = resolveOptionalApObjectId(intent.quoteOf);
    if (quoteId) {
      // FEP-044f primary quote property + compatibility aliases
      object["quote"] = quoteId;
      object["quoteUrl"] = quoteId;
      object["quoteUri"] = quoteId;
      object["_misskey_quote"] = quoteId;
    }
    // GoToSocial / FEP-044f interaction policy: advertise reply + quote policy on all published objects.
    object["interactionPolicy"] = buildApInteractionPolicy(intent.interactionPolicy, actorId);
    // Misskey FEP-e232 compatibility: include quote ref as a Link tag so tag-array consumers also find the quote ref
    const quoteLinkTags: Array<Record<string, unknown>> = quoteId
      ? [{
          type: "Link",
          mediaType: "application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"",
          rel: "https://misskey-hub.net/ns#_misskey_quote",
          href: quoteId,
        }]
      : [];
    const allTags = [...tag, ...quoteLinkTags];
    if (allTags.length > 0) {
      object["tag"] = allTags;
    }
    if (attachment.length > 0 || linkPreviewCard) {
      object["attachment"] = linkPreviewCard
        ? [...attachment, linkPreviewCard]
        : attachment;
    }

    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext({ includeCustomEmojis: customEmojis.length > 0 }),
      id: `${objectId}#update-${intent.canonicalIntentId.slice(0, 12)}`,
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
