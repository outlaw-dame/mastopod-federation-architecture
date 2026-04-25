/**
 * PollEditToAtProjector
 *
 * ATProto has no native poll record type.  Poll edits (vote count updates or
 * option changes) are projected as updates to the plain text `app.bsky.feed.post`
 * that was created by PollCreateToAtProjector, showing updated vote percentages.
 *
 * Lossiness: "major" — same constraints as PollCreateToAtProjector.
 */
import type { CanonicalIntent, CanonicalPollEditIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildPostMetadata, parseAtUri, normalizeAtText } from "./post-shared.js";

const POLL_DOWNGRADE_WARNING = {
  code: "AT_POLL_DOWNGRADED_TO_POST",
  message: "ATProto has no native poll record type; poll projected as a plain text post.",
  lossiness: "major" as const,
};

export class PollEditToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollEdit";
  }

  public async project(
    intent: CanonicalPollEditIntent,
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
    if (!primaryRef || primaryRef.collection !== "app.bsky.feed.post") {
      // No existing AT record — silently skip with lossiness warning.
      return {
        kind: "success",
        commands: [],
        lossiness: "major",
        warnings: [
          ...intent.warnings,
          {
            ...POLL_DOWNGRADE_WARNING,
            message: `${POLL_DOWNGRADE_WARNING.message} No existing AT post record found to update.`,
          },
        ],
      };
    }

    const totalVotes = intent.options.reduce((sum, o) => sum + o.voteCount, 0);
    const lines: string[] = [];
    if (intent.question.trim()) {
      lines.push(intent.question.trim());
    }
    for (const option of intent.options) {
      const pct = totalVotes > 0 ? Math.round((option.voteCount / totalVotes) * 100) : 0;
      const bullet = intent.mode === "anyOf" ? "☐" : "○";
      lines.push(`${bullet} ${option.name} — ${pct}% (${option.voteCount})`);
    }
    if (intent.endTime) {
      lines.push(`Ends: ${intent.endTime}`);
    }
    const text = normalizeAtText(lines.join("\n"));

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: intent.createdAt,
    };

    const warnings = [...intent.warnings, POLL_DOWNGRADE_WARNING];

    return {
      kind: "success",
      commands: [
        {
          kind: "createRecord",
          collection: "app.bsky.feed.post",
          repoDid: actor.did,
          rkey: primaryRef.rkey,
          record,
          canonicalRefIdHint: intent.object.canonicalObjectId,
          metadata: buildPostMetadata(intent),
        },
      ],
      lossiness: maxLossiness(warnings),
      warnings,
    };
  }
}
