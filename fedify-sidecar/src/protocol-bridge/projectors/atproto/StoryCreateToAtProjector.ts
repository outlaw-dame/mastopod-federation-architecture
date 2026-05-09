import { createHash } from "node:crypto";
import {
  ACTIVITYPODS_STORY_COLLECTION,
  normalizeActivityPodsStoryRecord,
} from "../../../at-adapter/lexicon/ActivityPodsStoryLexicon.js";
import type { CanonicalIntent, CanonicalStoryCreateIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionCommandMetadata,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";

export class StoryCreateToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "StoryCreate";
  }

  public async project(
    intent: CanonicalStoryCreateIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<AtProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    if (!actor.did) {
      return {
        kind: "error",
        code: "AT_REPO_DID_MISSING",
        message: "Cannot project a story to ATProto without a repository DID.",
      };
    }

    const record: Record<string, unknown> = {
      $type: ACTIVITYPODS_STORY_COLLECTION,
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
      visibility: intent.visibility === "unlisted" ? "unlisted" : "public",
      media: intent.media,
      allowReplies: intent.allowReplies ?? true,
    };

    if (intent.text) record["text"] = intent.text;
    if (intent.facets && intent.facets.length > 0) record["facets"] = intent.facets;
    if (intent.links && intent.links.length > 0) record["links"] = intent.links;
    if (intent.labels && intent.labels.length > 0) record["labels"] = intent.labels;
    if (intent.langs && intent.langs.length > 0) record["langs"] = intent.langs;

    const normalized = normalizeActivityPodsStoryRecord(record, {
      now: intent.observedAt,
      requireActive: true,
    });
    if (!normalized) {
      return {
        kind: "error",
        code: "AT_STORY_INVALID",
        message: "Canonical story could not be represented as a valid active org.activitypods.story.slide record.",
      };
    }

    return {
      kind: "success",
      commands: [
        {
          kind: "createRecord",
          collection: ACTIVITYPODS_STORY_COLLECTION,
          repoDid: actor.did,
          rkey: deriveStoryRkey(intent),
          canonicalRefIdHint: intent.object.canonicalObjectId,
          record: normalized,
          metadata: buildStoryMetadata(intent),
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}

export function deriveStoryRkey(intent: CanonicalStoryCreateIntent): string {
  return createHash("sha256")
    .update(`${intent.canonicalIntentId}:story`)
    .digest("hex")
    .slice(0, 13);
}

export function buildStoryMetadata(intent: CanonicalStoryCreateIntent): ProjectionCommandMetadata {
  return {
    canonicalIntentId: intent.canonicalIntentId,
    sourceProtocol: intent.sourceProtocol,
    provenance: intent.provenance,
  };
}
