/**
 * Shared helpers for FEP-9967 poll AP projection.
 */
import type {
  CanonicalPollCreateIntent,
  CanonicalPollEditIntent,
} from "../../canonical/CanonicalIntent.js";
import { escapeHtml } from "./PostCreateToApProjector.js";

type PollWriteIntent = CanonicalPollCreateIntent | CanonicalPollEditIntent;

/**
 * Build the AP Question object body shared by Create and Update activities.
 */
export function buildPollQuestionObject(
  intent: PollWriteIntent,
  actorId: string,
  objectId: string,
  audience: { to: string[]; cc: string[] },
): Record<string, unknown> {
  const optionNotes = intent.options.map((option) => ({
    type: "Note",
    name: option.name,
    replies: {
      type: "Collection",
      totalItems: option.voteCount,
    },
  }));

  const questionHtml = intent.question
    ? `<p>${escapeHtml(intent.question)}</p>`
    : "";

  const object: Record<string, unknown> = {
    id: objectId,
    type: "Question",
    attributedTo: actorId,
    content: questionHtml,
    [intent.mode]: optionNotes,
    published: intent.createdAt,
    updated: intent.createdAt,
    to: audience.to,
    cc: audience.cc,
    url: intent.object.canonicalUrl ?? intent.object.activityPubObjectId ?? objectId,
  };

  if (intent.endTime) {
    // FEP-9967: consumers MUST process `closed` the same as `endTime`
    object["endTime"] = intent.endTime;
    object["closed"] = intent.endTime;
  }

  if (typeof intent.votersCount === "number") {
    // Mastodon votersCount extension
    object["votersCount"] = intent.votersCount;
  }

  return object;
}
