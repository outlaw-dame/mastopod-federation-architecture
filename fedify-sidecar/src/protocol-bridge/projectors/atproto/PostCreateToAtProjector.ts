import type { CanonicalIntent, CanonicalPostCreateIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import { canonicalFacetsToAtFacets } from "../../text/CanonicalTextToAtFacets.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import {
  articleTeaserCanonicalRefId,
  buildExternalLinkEmbed,
  buildImageEmbedFromAttachments,
  buildVideoEmbedFromAttachments,
  buildArticleTeaser,
  buildTeaserAtFacets,
  buildPostMetadata,
  deriveArticleTeaserRkey,
  deriveProjectedPostRkey,
  normalizeAtText,
  selectPreferredAtMediaAttachments,
  toAttachmentMediaHints,
} from "./post-shared.js";

export class PostCreateToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostCreate";
  }

  public async project(
    intent: CanonicalPostCreateIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REPO_DID_MISSING",
        message: "Cannot project to ATProto without a repository DID.",
      };
    }

    const warnings = [...intent.warnings];
    const commands: AtProjectionCommand[] = [];
    const replyRef = buildReplyRef(intent, warnings);
    const baseMetadata = buildPostMetadata(intent);
    const articleRkey = intent.content.kind === "article"
      ? deriveProjectedPostRkey(intent, "article")
      : undefined;

    if (intent.content.kind === "article") {
      warnings.push({
        code: "AT_STANDARD_DOCUMENT_SCHEMA_ASSUMED",
        message: "Article projection uses an internal site.standard.document draft record shape until the native adapter defines the final lexicon.",
        lossiness: "minor",
      });

      commands.push({
        kind: "createRecord",
        collection: "site.standard.document",
        repoDid: actor.did,
        rkey: articleRkey,
        canonicalRefIdHint: intent.object.canonicalObjectId,
        record: {
          $type: "site.standard.document",
          title: intent.content.title ?? null,
          summary: intent.content.summary ?? null,
          text: intent.content.plaintext,
          publishedAt: intent.createdAt,
          url: intent.content.externalUrl ?? intent.object.canonicalUrl ?? null,
        },
        metadata: baseMetadata,
      });
    }

    const teaserText = intent.content.kind === "article"
      ? buildArticleTeaser(intent)
      : normalizeAtText(intent.content.plaintext);

    const postRecord: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: teaserText,
      createdAt: intent.createdAt,
    };

    if (intent.content.language) {
      postRecord["langs"] = [intent.content.language];
    }

    const facets = intent.content.kind === "article"
      ? buildTeaserAtFacets(
          teaserText,
          intent.content.facets,
          intent.content.linkPreview?.uri ?? intent.content.externalUrl ?? intent.object.canonicalUrl,
        )
      : canonicalFacetsToAtFacets(teaserText, intent.content.facets);
    if (facets.length > 0) {
      postRecord["facets"] = facets;
    }
    if (replyRef) {
      postRecord["reply"] = replyRef;
    }

    const mediaSelection = selectPreferredAtMediaAttachments(intent.content.attachments);
    const videoEmbed = buildVideoEmbedFromAttachments(mediaSelection.attachments);
    const imageEmbed = buildImageEmbedFromAttachments(mediaSelection.attachments);
    const externalEmbed = buildExternalLinkEmbed(intent.content.linkPreview);
    if (mediaSelection.kind === "video") {
      if (videoEmbed) {
        postRecord["embed"] = videoEmbed;
      }
      if (mediaSelection.imageCount > 0) {
        warnings.push({
          code: "AT_IMAGE_ATTACHMENTS_SKIPPED_WITH_VIDEO",
          message: "AT posts support only one media embed; video attachments were prioritized over images.",
          lossiness: "minor",
        });
      }
      if (mediaSelection.droppedCount > 0) {
        warnings.push({
          code: "AT_VIDEO_ATTACHMENT_TRUNCATED",
          message: "AT posts support only a single video embed; additional videos were omitted.",
          lossiness: "minor",
        });
      }
      if (externalEmbed) {
        warnings.push({
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_VIDEO",
          message: "AT posts support only one embed; video attachments were prioritized over link previews.",
          lossiness: "minor",
        });
      }
    } else if (mediaSelection.kind === "images") {
      if (imageEmbed) {
        postRecord["embed"] = imageEmbed;
      }
      if (mediaSelection.droppedCount > 0) {
        warnings.push({
          code: "AT_IMAGE_ATTACHMENT_TRUNCATED",
          message: "AT posts support up to four images; additional images were omitted.",
          lossiness: "minor",
        });
      }
      if (externalEmbed) {
        warnings.push({
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_IMAGES",
          message: "AT posts support only one embed; image attachments were prioritized over link previews.",
          lossiness: "minor",
        });
      }
    } else if (externalEmbed) {
      postRecord["embed"] = externalEmbed;
    }

    commands.push({
      kind: "createRecord",
      collection: "app.bsky.feed.post",
      repoDid: actor.did,
      rkey: intent.content.kind === "article"
        ? deriveArticleTeaserRkey(articleRkey!)
        : deriveProjectedPostRkey(intent, "note"),
      canonicalRefIdHint:
        intent.content.kind === "article"
          ? articleTeaserCanonicalRefId(intent.object.canonicalObjectId)
          : intent.object.canonicalObjectId,
      linkPreviewThumbUrlHint: intent.content.linkPreview?.thumbUrl ?? null,
      ...(mediaSelection.kind
        ? { attachmentMediaHints: toAttachmentMediaHints(mediaSelection.attachments) }
        : {}),
      record: postRecord,
      metadata: baseMetadata,
    });

    return {
      kind: "success",
      commands,
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
}

function buildReplyRef(
  intent: CanonicalPostCreateIntent,
  warnings: CanonicalPostCreateIntent["warnings"],
): Record<string, unknown> | undefined {
  const parentUri = intent.inReplyTo?.atUri;
  const parentCid = intent.inReplyTo?.cid;

  if (!parentUri) {
    return undefined;
  }
  if (!parentCid) {
    warnings.push({
      code: "AT_REPLY_REFERENCE_SKIPPED",
      message: "AT reply projection requires both a parent URI and CID; the reply reference was omitted.",
      lossiness: "minor",
    });
    return undefined;
  }

  return {
    root: {
      uri: parentUri,
      cid: parentCid,
    },
    parent: {
      uri: parentUri,
      cid: parentCid,
    },
  };
}
