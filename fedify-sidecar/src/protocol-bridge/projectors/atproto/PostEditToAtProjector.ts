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
  buildArticleTeaser,
  buildTeaserAtFacets,
  buildPostMetadata,
  deriveArticleTeaserRkey,
  normalizeAtText,
  parseAtUri,
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
        const externalEmbed = buildExternalLinkEmbed(intent.content.linkPreview);
        if (externalEmbed) {
          teaserRecord["embed"] = externalEmbed;
        }

        commands.push({
          kind: "updateRecord",
          collection: "app.bsky.feed.post",
          repoDid: actor.did,
          rkey: parsedTeaserRef.rkey,
          canonicalRefIdHint: articleTeaserCanonicalRefId(intent.object.canonicalObjectId),
          linkPreviewThumbUrlHint: intent.content.linkPreview?.thumbUrl ?? null,
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

    const imageEmbed = buildImageEmbedFromAttachments(intent.content.attachments);
    const externalEmbed = buildExternalLinkEmbed(intent.content.linkPreview);
    if (imageEmbed) {
      record["embed"] = imageEmbed;
      if (externalEmbed) {
        warnings.push({
          code: "AT_LINK_PREVIEW_SKIPPED_WITH_IMAGES",
          message: "AT posts support only one embed; image attachments were prioritized over link previews.",
          lossiness: "minor",
        });
      }
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
          record,
          metadata: baseMetadata,
        },
      ],
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
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
