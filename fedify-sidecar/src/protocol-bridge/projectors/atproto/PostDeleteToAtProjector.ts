import type { CanonicalIntent, CanonicalPostDeleteIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import {
  articleTeaserCanonicalRefId,
  buildPostMetadata,
  deriveArticleTeaserRkey,
  parseAtUri,
} from "./post-shared.js";

export class PostDeleteToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostDelete";
  }

  public async project(
    intent: CanonicalPostDeleteIntent,
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

    const primaryRef = parseAtUri(intent.object.atUri, actor.did);
    if (!primaryRef) {
      return {
        kind: "error",
        code: "AT_DELETE_URI_MISSING",
        message: "Post deletes require the canonical object to resolve to an AT URI.",
      };
    }

    const commands: AtProjectionCommand[] = [
      {
        kind: "deleteRecord",
        collection: primaryRef.collection,
        repoDid: actor.did,
        rkey: primaryRef.rkey,
        canonicalRefIdHint: intent.object.canonicalObjectId,
        metadata: buildPostMetadata(intent),
      },
    ];
    const warnings = [...intent.warnings];

    if (primaryRef.collection === "site.standard.document") {
      const teaserRef = await ctx.resolveObjectRef({
        canonicalObjectId: articleTeaserCanonicalRefId(intent.object.canonicalObjectId),
      });
      const parsedTeaserRef = parseAtUri(teaserRef.atUri, actor.did)
        ?? {
          collection: "app.bsky.feed.post",
          rkey: deriveArticleTeaserRkey(primaryRef.rkey),
        };
      if (parsedTeaserRef.collection === "app.bsky.feed.post") {
        commands.push({
          kind: "deleteRecord",
          collection: "app.bsky.feed.post",
          repoDid: actor.did,
          rkey: parsedTeaserRef.rkey,
          canonicalRefIdHint: articleTeaserCanonicalRefId(intent.object.canonicalObjectId),
          metadata: buildPostMetadata(intent),
        });
      } else {
        warnings.push({
          code: "AT_ARTICLE_TEASER_DELETE_SKIPPED",
          message: "The article teaser could not be resolved to an app.bsky.feed.post target, so only the longform record will be deleted.",
          lossiness: "minor",
        });
      }
    }

    return {
      kind: "success",
      commands,
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
}
