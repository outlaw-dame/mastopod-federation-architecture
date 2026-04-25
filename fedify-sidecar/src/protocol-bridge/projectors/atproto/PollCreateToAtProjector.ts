/**
 * PollCreateToAtProjector
 *
 * ATProto has no native poll record type.  As a best-effort cross-protocol
 * projection this projector emits an `app.bsky.feed.post` with the poll
 * question text followed by the option list so the content is readable in
 * AT-native clients.
 *
 * Lossiness: "major" — option vote counts, expiry, and voting semantics
 * are all dropped.  Consuming code (AT-side clients) sees a plain text post.
 */
import type { CanonicalIntent, CanonicalPollCreateIntent } from "../../canonical/CanonicalIntent.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import type {
  AtProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { buildPostMetadata, deriveProjectedPostRkey, normalizeAtText } from "./post-shared.js";

export class PollCreateToAtProjector implements CanonicalProjector<AtProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "PollCreate";
  }

  public async project(
    intent: CanonicalPollCreateIntent,
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

    const rkey = deriveProjectedPostRkey(
      // PollCreate is structurally compatible enough for rkey derivation.
      intent as unknown as Parameters<typeof deriveProjectedPostRkey>[0],
      "poll-post",
    );
    const text = buildPollText(intent);

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: intent.createdAt,
    };

    return {
      kind: "success",
      commands: [
        {
          kind: "createRecord",
          collection: "app.bsky.feed.post",
          repoDid: actor.did,
          rkey,
          record,
          canonicalRefIdHint: intent.object.canonicalObjectId,
          metadata: buildPostMetadata(intent),
        },
      ],
      // Voting semantics and expiry are not representable in ATProto.
      lossiness: maxLossiness([
        ...intent.warnings,
        {
          code: "AT_POLL_DOWNGRADED_TO_POST",
          message: "ATProto has no native poll record type; poll projected as a plain text post.",
          lossiness: "major",
        },
      ]),
      warnings: [
        ...intent.warnings,
        {
          code: "AT_POLL_DOWNGRADED_TO_POST",
          message: "ATProto has no native poll record type; poll projected as a plain text post.",
          lossiness: "major" as const,
        },
      ],
    };
  }
}

function buildPollText(intent: CanonicalPollCreateIntent): string {
  const lines: string[] = [];
  if (intent.question.trim()) {
    lines.push(intent.question.trim());
  }
  for (const option of intent.options) {
    const bullet = intent.mode === "anyOf" ? "☐" : "○";
    lines.push(`${bullet} ${option.name}`);
  }
  if (intent.endTime) {
    lines.push(`Ends: ${intent.endTime}`);
  }
  return normalizeAtText(lines.join("\n"));
}
