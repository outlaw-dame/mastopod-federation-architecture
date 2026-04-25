import type {
  CanonicalIntent,
  CanonicalPostInteractionPolicyUpdateIntent,
} from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import {
  buildPostgateRecord,
  buildThreadgateRecord,
  buildPostMetadata,
  parseAtUri,
} from "./post-shared.js";

/**
 * Projects a `PostInteractionPolicyUpdate` canonical intent to ATProto gate
 * record operations.
 *
 * ATProto gate records must share the same `rkey` as their parent post, and
 * are stored in separate collections:
 *   `app.bsky.feed.threadgate` — controls `canReply`
 *   `app.bsky.feed.postgate`   — controls `canQuote`
 *
 * Projection rules:
 *   canReply absent      → no threadgate command emitted
 *   canReply "everyone"  → deleteRecord (removes the gate; default = unrestricted)
 *   canReply non-default → createRecord (AT adapter should use putRecord semantics
 *                          for idempotency if the gate already exists)
 *
 *   canQuote absent      → no postgate command emitted
 *   canQuote "everyone"  → deleteRecord
 *   canQuote non-default → createRecord
 *
 * The post's AT URI must be resolvable from `intent.object.atUri`; if not,
 * the projector returns an error.
 */
export class PostInteractionPolicyUpdateToAtProjector
  implements CanonicalProjector<AtProjectionCommand>
{
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PostInteractionPolicyUpdate";
  }

  public async project(
    intent: CanonicalPostInteractionPolicyUpdateIntent,
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

    // Gate records share the post's rkey, so we derive it from the post URI.
    const postRef = parseAtUri(intent.object.atUri, actor.did);
    if (!postRef || postRef.collection !== "app.bsky.feed.post") {
      return {
        kind: "error",
        code: "AT_POST_URI_MISSING",
        message:
          "PostInteractionPolicyUpdate projection requires the object to resolve to an app.bsky.feed.post AT URI.",
      };
    }

    const { rkey: postRkey } = postRef;
    const postAtUri = `at://${actor.did}/app.bsky.feed.post/${postRkey}`;
    const baseMetadata = buildPostMetadata(intent);
    const commands: AtProjectionCommand[] = [];
    const warnings = [...intent.warnings];

    // -----------------------------------------------------------------------
    // threadgate (canReply)
    // -----------------------------------------------------------------------
    if (intent.canReply !== undefined && intent.canReply !== null) {
      const threadgateRecord = buildThreadgateRecord(
        { canReply: intent.canReply, canQuote: "everyone" },
        postAtUri,
        intent.createdAt,
      );

      if (threadgateRecord) {
        // Non-default policy: create (or overwrite via putRecord at the adapter layer).
        commands.push({
          kind: "createRecord",
          collection: "app.bsky.feed.threadgate",
          repoDid: actor.did,
          rkey: postRkey,
          record: threadgateRecord,
          metadata: baseMetadata,
        });
      } else {
        // canReply reverted to "everyone": remove the gate record.
        commands.push({
          kind: "deleteRecord",
          collection: "app.bsky.feed.threadgate",
          repoDid: actor.did,
          rkey: postRkey,
          metadata: baseMetadata,
        });
      }
    }

    // -----------------------------------------------------------------------
    // postgate (canQuote)
    // -----------------------------------------------------------------------
    if (intent.canQuote !== undefined && intent.canQuote !== null) {
      const postgateRecord = buildPostgateRecord(
        { canReply: "everyone", canQuote: intent.canQuote },
        postAtUri,
        intent.createdAt,
      );

      if (postgateRecord) {
        commands.push({
          kind: "createRecord",
          collection: "app.bsky.feed.postgate",
          repoDid: actor.did,
          rkey: postRkey,
          record: postgateRecord,
          metadata: baseMetadata,
        });
      } else {
        // canQuote reverted to "everyone": remove the gate record.
        commands.push({
          kind: "deleteRecord",
          collection: "app.bsky.feed.postgate",
          repoDid: actor.did,
          rkey: postRkey,
          metadata: baseMetadata,
        });
      }
    }

    if (commands.length === 0) {
      // Both axes were absent — the intent carries no actionable policy change.
      warnings.push({
        code: "AT_INTERACTION_POLICY_UPDATE_NOOP",
        message:
          "PostInteractionPolicyUpdate intent carried no canReply or canQuote field; no gate records were updated.",
        lossiness: "none",
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
