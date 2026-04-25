import type { CanonicalIntent, CanonicalPostCreateIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import { canonicalFacetsToAtFacets } from "../../text/CanonicalTextToAtFacets.js";
import { buildActivityPodsCustomEmojiField, ACTIVITYPODS_CUSTOM_EMOJIS_FIELD } from "../../../at-adapter/lexicon/ActivityPodsEmojiLexicon.js";
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
  buildPostgateRecord,
  buildThreadgateRecord,
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
          ...(buildActivityPodsCustomEmojiField(intent.content.customEmojis)
            ? { [ACTIVITYPODS_CUSTOM_EMOJIS_FIELD]: buildActivityPodsCustomEmojiField(intent.content.customEmojis)! }
            : {}),
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
    const customEmojiField = buildActivityPodsCustomEmojiField(intent.content.customEmojis);
    if (customEmojiField && intent.content.kind !== "article") {
      postRecord[ACTIVITYPODS_CUSTOM_EMOJIS_FIELD] = customEmojiField;
    }

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
      postRecord["embed"] = mediaEmbed
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
        postRecord["embed"] = mediaEmbed;
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
      postRecord["embed"] = mediaEmbed;
    } else if (externalEmbed) {
      postRecord["embed"] = externalEmbed;
    }

    const postRkey = intent.content.kind === "article"
      ? deriveArticleTeaserRkey(articleRkey!)
      : deriveProjectedPostRkey(intent, "note");

    commands.push({
      kind: "createRecord",
      collection: "app.bsky.feed.post",
      repoDid: actor.did,
      rkey: postRkey,
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

    // Emit companion gate records when the interaction policy is non-default.
    // Both records MUST use the same rkey as the post (AT protocol requirement).
    // These are only emitted at creation time; policy changes after the fact
    // require a separate gate update flow (not yet modelled in CanonicalIntent).
    const postAtUri = `at://${actor.did}/app.bsky.feed.post/${postRkey}`;

    const threadgateRecord = buildThreadgateRecord(intent.interactionPolicy, postAtUri, intent.createdAt);
    if (threadgateRecord) {
      commands.push({
        kind: "createRecord",
        collection: "app.bsky.feed.threadgate",
        repoDid: actor.did,
        rkey: postRkey,
        record: threadgateRecord,
        metadata: baseMetadata,
      });
    }

    const postgateRecord = buildPostgateRecord(intent.interactionPolicy, postAtUri, intent.createdAt);
    if (postgateRecord) {
      commands.push({
        kind: "createRecord",
        collection: "app.bsky.feed.postgate",
        repoDid: actor.did,
        rkey: postRkey,
        record: postgateRecord,
        metadata: baseMetadata,
      });
    }

    return {
      kind: "success",
      commands,
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
}

async function resolveQuotedRecordRef(
  intent: CanonicalPostCreateIntent,
  ctx: ProjectionContext,
  warnings: CanonicalPostCreateIntent["warnings"],
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
