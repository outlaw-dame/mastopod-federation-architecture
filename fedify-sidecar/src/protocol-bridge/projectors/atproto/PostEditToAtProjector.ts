import type { CanonicalIntent, CanonicalPostEditIntent } from "../../canonical/CanonicalIntent.js";
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
  normalizeAtText,
  parseAtUri,
  selectPreferredAtMediaAttachments,
  toAttachmentMediaHints,
} from "./post-shared.js";

export class PostEditToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostEdit";
  }

  public async project(
    intent: CanonicalPostEditIntent,
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
    const baseMetadata = buildPostMetadata(intent);

    if (intent.content.kind === "article") {
      const primaryRef = parseAtUri(intent.object.atUri, actor.did);
      if (!primaryRef || primaryRef.collection !== "site.standard.document") {
        return {
          kind: "error",
          code: "AT_ARTICLE_URI_MISSING",
          message: "Article edits require the canonical article object to resolve to a site.standard.document AT URI.",
        };
      }

      const commands: AtProjectionCommand[] = [
        {
          kind: "updateRecord",
          collection: "site.standard.document",
          repoDid: actor.did,
          rkey: primaryRef.rkey,
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
        },
      ];

      const teaserRef = await ctx.resolveObjectRef({
        canonicalObjectId: articleTeaserCanonicalRefId(intent.object.canonicalObjectId),
      });
      const parsedTeaserRef = parseAtUri(teaserRef.atUri, actor.did)
        ?? {
          collection: "app.bsky.feed.post",
          rkey: deriveArticleTeaserRkey(primaryRef.rkey),
        };
      if (parsedTeaserRef.collection === "app.bsky.feed.post") {
        const teaserText = buildArticleTeaser(intent);
        const teaserRecord: Record<string, unknown> = {
          $type: "app.bsky.feed.post",
          text: teaserText,
          createdAt: intent.createdAt,
        };
        if (intent.content.language) {
          teaserRecord["langs"] = [intent.content.language];
        }
        const facets = buildTeaserAtFacets(
          teaserText,
          intent.content.facets,
          intent.content.linkPreview?.uri ?? intent.content.externalUrl ?? intent.object.canonicalUrl,
        );
        if (facets.length > 0) {
          teaserRecord["facets"] = facets;
        }
        const teaserMediaSelection = selectPreferredAtMediaAttachments(intent.content.attachments);
        const videoEmbed = buildVideoEmbedFromAttachments(teaserMediaSelection.attachments);
        const imageEmbed = buildImageEmbedFromAttachments(teaserMediaSelection.attachments);
        const externalEmbed = buildExternalLinkEmbed(intent.content.linkPreview);
        const quoteRecord = await resolveQuotedRecordRef(intent, ctx, warnings);
        let mediaEmbed: Record<string, unknown> | null = null;
        if (teaserMediaSelection.kind === "video") {
          if (videoEmbed) {
            mediaEmbed = videoEmbed;
          }
          if (teaserMediaSelection.imageCount > 0) {
            warnings.push({
              code: "AT_IMAGE_ATTACHMENTS_SKIPPED_WITH_VIDEO",
              message: "AT posts support only one media embed; video attachments were prioritized over images.",
              lossiness: "minor",
            });
          }
          if (teaserMediaSelection.droppedCount > 0) {
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
        } else if (teaserMediaSelection.kind === "images") {
          if (imageEmbed) {
            mediaEmbed = imageEmbed;
          }
          if (teaserMediaSelection.droppedCount > 0) {
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
        }

        if (quoteRecord) {
          teaserRecord["embed"] = mediaEmbed
            ? {
                $type: "app.bsky.embed.recordWithMedia",
                record: quoteRecord,
                media: mediaEmbed,
              }
            : {
                $type: "app.bsky.embed.record",
                record: quoteRecord,
              };
          if (externalEmbed) {
            warnings.push({
              code: "AT_LINK_PREVIEW_SKIPPED_WITH_QUOTE",
              message: "AT posts support only one embed; quoted-record embeds were prioritized over link previews.",
              lossiness: "minor",
            });
          }
        } else if (teaserMediaSelection.kind) {
          if (mediaEmbed) {
            teaserRecord["embed"] = mediaEmbed;
          }
          if (!mediaEmbed && externalEmbed) {
            warnings.push({
              code: teaserMediaSelection.kind === "video"
                ? "AT_LINK_PREVIEW_SKIPPED_WITH_VIDEO"
                : "AT_LINK_PREVIEW_SKIPPED_WITH_IMAGES",
              message: teaserMediaSelection.kind === "video"
                ? "AT posts support only one embed; video attachments were prioritized over link previews."
                : "AT posts support only one embed; image attachments were prioritized over link previews.",
              lossiness: "minor",
            });
          }
        } else if (mediaEmbed) {
          teaserRecord["embed"] = mediaEmbed;
        } else if (externalEmbed) {
          teaserRecord["embed"] = externalEmbed;
        }

        commands.push({
          kind: "updateRecord",
          collection: "app.bsky.feed.post",
          repoDid: actor.did,
          rkey: parsedTeaserRef.rkey,
          canonicalRefIdHint: articleTeaserCanonicalRefId(intent.object.canonicalObjectId),
          linkPreviewThumbUrlHint: intent.content.linkPreview?.thumbUrl ?? null,
          ...(teaserMediaSelection.kind
            ? { attachmentMediaHints: toAttachmentMediaHints(teaserMediaSelection.attachments) }
            : {}),
          record: teaserRecord,
          metadata: baseMetadata,
        });
      } else {
        warnings.push({
          code: "AT_ARTICLE_TEASER_UPDATE_SKIPPED",
          message: "The article teaser could not be resolved to an app.bsky.feed.post target, so only the longform record will be updated.",
          lossiness: "minor",
        });
      }

      return {
        kind: "success",
        commands,
        lossiness: maxLossiness(warnings),
        warnings,
      };
    }

    const primaryRef = parseAtUri(intent.object.atUri, actor.did);
    if (!primaryRef || primaryRef.collection !== "app.bsky.feed.post") {
      return {
        kind: "error",
        code: "AT_POST_URI_MISSING",
        message: "Post edits require the canonical post object to resolve to an app.bsky.feed.post AT URI.",
      };
    }

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: normalizeAtText(intent.content.plaintext),
      createdAt: intent.createdAt,
    };
    if (intent.content.language) {
      record["langs"] = [intent.content.language];
    }
    const facets = canonicalFacetsToAtFacets(record["text"] as string, intent.content.facets);
    if (facets.length > 0) {
      record["facets"] = facets;
    }
    const replyRef = buildReplyRef(intent, warnings);
    if (replyRef) {
      record["reply"] = replyRef;
    }

    const mediaSelection = selectPreferredAtMediaAttachments(intent.content.attachments);
    const videoEmbed = buildVideoEmbedFromAttachments(mediaSelection.attachments);
    const imageEmbed = buildImageEmbedFromAttachments(mediaSelection.attachments);
    const externalEmbed = buildExternalLinkEmbed(intent.content.linkPreview);
    const quoteRecord = await resolveQuotedRecordRef(intent, ctx, warnings);
    let mediaEmbed: Record<string, unknown> | null = null;
    if (mediaSelection.kind === "video") {
      if (videoEmbed) {
        mediaEmbed = videoEmbed;
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
        mediaEmbed = imageEmbed;
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
    }

    if (quoteRecord) {
      record["embed"] = mediaEmbed
        ? {
            $type: "app.bsky.embed.recordWithMedia",
            record: quoteRecord,
            media: mediaEmbed,
          }
        : {
            $type: "app.bsky.embed.record",
            record: quoteRecord,
          };
      if (externalEmbed) {
        warnings.push({
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_QUOTE",
          message: "AT posts support only one embed; quoted-record embeds were prioritized over link previews.",
          lossiness: "minor",
        });
      }
    } else if (mediaSelection.kind) {
      if (mediaEmbed) {
        record["embed"] = mediaEmbed;
      }
      if (!mediaEmbed && externalEmbed) {
        warnings.push({
          code: mediaSelection.kind === "video"
            ? "AT_LINK_PREVIEW_SKIPPED_WITH_VIDEO"
            : "AT_LINK_PREVIEW_SKIPPED_WITH_IMAGES",
          message: mediaSelection.kind === "video"
            ? "AT posts support only one embed; video attachments were prioritized over link previews."
            : "AT posts support only one embed; image attachments were prioritized over link previews.",
          lossiness: "minor",
        });
      }
    } else if (mediaEmbed) {
      record["embed"] = mediaEmbed;
    } else if (externalEmbed) {
      record["embed"] = externalEmbed;
    }

    return {
      kind: "success",
      commands: [
        {
          kind: "updateRecord",
          collection: "app.bsky.feed.post",
          repoDid: actor.did,
          rkey: primaryRef.rkey,
          canonicalRefIdHint: intent.object.canonicalObjectId,
          linkPreviewThumbUrlHint: intent.content.linkPreview?.thumbUrl ?? null,
          ...(mediaSelection.kind
            ? { attachmentMediaHints: toAttachmentMediaHints(mediaSelection.attachments) }
            : {}),
          record,
          metadata: baseMetadata,
        },
      ],
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
}

async function resolveQuotedRecordRef(
  intent: CanonicalPostEditIntent,
  ctx: ProjectionContext,
  warnings: CanonicalPostEditIntent["warnings"],
): Promise<{ uri: string; cid: string } | null> {
  if (!intent.quoteOf) {
    return null;
  }

  const quoteTarget = await ctx.resolveObjectRef(intent.quoteOf);
  if (!quoteTarget.atUri || !quoteTarget.cid) {
    warnings.push({
      code: "AT_QUOTE_REFERENCE_SKIPPED",
      message: "AT quoted-record projection requires both a quote target AT URI and CID; the quote embed was omitted.",
      lossiness: "minor",
    });
    return null;
  }

  return {
    uri: quoteTarget.atUri,
    cid: quoteTarget.cid,
  };
}

function buildReplyRef(
  intent: CanonicalPostEditIntent,
  warnings: CanonicalPostEditIntent["warnings"],
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
