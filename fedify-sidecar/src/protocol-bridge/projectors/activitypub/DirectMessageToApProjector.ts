import type { CanonicalIntent, CanonicalDirectMessageIntent } from "../../canonical/CanonicalIntent.js";
import type {
  ActivityPubProjectionCommand,
  ProjectionContext,
  ProjectionResult,
} from "../../ports/ProtocolBridgePorts.js";
import type { CanonicalProjector } from "../../registry/ProjectorRegistry.js";
import { canonicalActorIdentityKey } from "../../canonical/CanonicalActorRef.js";
import { maxLossiness } from "../../canonical/CanonicalWarnings.js";
import {
  buildApActivityContext,
  buildApLinkPreviewAttachment,
  resolveOptionalApObjectId,
} from "./post-shared.js";
import {
  canonicalFacetsToApTags,
  canonicalAttachmentsToApAttachments,
} from "./PostCreateToApProjector.js";

/**
 * Projects a `CanonicalDirectMessageIntent` to an ActivityPub `Create(Note)`
 * addressed exclusively to the conversation participants.
 *
 * Privacy guarantees:
 *   - `to` contains only the explicit recipient URIs (never the public stream).
 *   - `cc` is always empty.
 *   - Hashtag `tag` entries carry no `href` (private hashtags must not link to
 *     public tag indexes).
 *   - Mentions are restricted to participants by the translator; the projector
 *     enforces this a second time by filtering the `tag` array.
 */
export class DirectMessageToApProjector implements CanonicalProjector<ActivityPubProjectionCommand> {
  public supports(intent: CanonicalIntent): boolean {
    return intent.kind === "DirectMessage";
  }

  public async project(
    intent: CanonicalDirectMessageIntent,
    ctx: ProjectionContext,
  ): Promise<ProjectionResult<ActivityPubProjectionCommand>> {
    const actor = await ctx.resolveActorRef(intent.sourceAccountRef);
    const actorId = actor.activityPubActorUri;
    if (!actorId) {
      return {
        kind: "error",
        code: "AP_ACTOR_URI_MISSING",
        message: `Cannot project ${canonicalActorIdentityKey(actor)} to ActivityPub without an actor URI.`,
      };
    }

    // All participants: primary recipient + any additional (group DM)
    const allRecipients = [intent.recipient, ...intent.additionalRecipients];
    const recipientUris = allRecipients
      .map((r) => r.activityPubActorUri)
      .filter((uri): uri is string => typeof uri === "string" && uri.length > 0);

    if (recipientUris.length === 0) {
      return {
        kind: "error",
        code: "AP_DM_NO_RECIPIENTS",
        message: "Cannot project DirectMessage: no recipient actor URIs could be resolved.",
      };
    }

    // Participant set for mention filtering (sender + all recipients)
    const participantUriSet = new Set([actorId, ...recipientUris]);

    const customEmojis = intent.customEmojis ?? [];
    const actorOrigin = safeOrigin(actorId);

    // Build AP tag array from facets:
    //   - Mentions: only participants, with href
    //   - Hashtags: omit href (private — must not link to public index)
    //   - Custom emoji: included normally
    const participantScopedFacets = intent.facets.filter((facet) => {
      if (facet.type !== "mention") return true;
      const uri = facet.target.activityPubActorUri;
      return typeof uri === "string" && participantUriSet.has(uri);
    });

    const rawApTags = canonicalFacetsToApTags(participantScopedFacets, actorOrigin, customEmojis);

    // Strip href from all Hashtag tags so private hashtags aren't linkified
    const apTags = rawApTags.map((tag) =>
      typeof tag["type"] === "string" && tag["type"] === "Hashtag"
        ? { type: tag["type"], name: tag["name"] }
        : tag,
    );

    // Build attachment array (media + link preview)
    const mediaAttachments = canonicalAttachmentsToApAttachments(intent.attachments);
    const linkPreviewAttachment = buildApLinkPreviewAttachment(intent.linkPreview);
    const allAttachments = linkPreviewAttachment
      ? [...mediaAttachments, linkPreviewAttachment]
      : mediaAttachments;

    // Build body HTML from text (preserve newlines as <br>)
    const html = `<p>${escapeHtml(intent.text).replace(/\n/g, "<br>")}</p>`;

    const objectId = `${actorId}/dms/${encodeURIComponent(intent.messageId)}`;

    const object: Record<string, unknown> = {
      id: objectId,
      type: "Note",
      attributedTo: actorId,
      content: html,
      published: intent.createdAt,
      to: recipientUris,
      cc: [],
    };

    const inReplyToId = resolveOptionalApObjectId(intent.inReplyTo);
    if (inReplyToId) {
      object["inReplyTo"] = inReplyToId;
    }

    const quoteId = resolveOptionalApObjectId(intent.quoteOf);
    if (quoteId) {
      object["quote"] = quoteId;
      object["quoteUrl"] = quoteId;
      object["quoteUri"] = quoteId;
      object["_misskey_quote"] = quoteId;
    }

    if (apTags.length > 0) {
      object["tag"] = apTags;
    }
    if (allAttachments.length > 0) {
      object["attachment"] = allAttachments;
    }

    const activity: Record<string, unknown> = {
      "@context": buildApActivityContext({ includeCustomEmojis: customEmojis.length > 0 }),
      id: `${objectId}#create`,
      type: "Create",
      actor: actorId,
      object,
      published: intent.createdAt,
      to: recipientUris,
      cc: [],
    };

    return {
      kind: "success",
      commands: [
        {
          kind: "publishActivity",
          activity,
          targetTopic: "ap.outbound.v1",
          metadata: {
            canonicalIntentId: intent.canonicalIntentId,
            sourceProtocol: intent.sourceProtocol,
            provenance: intent.provenance,
          },
        },
      ],
      lossiness: maxLossiness(intent.warnings),
      warnings: intent.warnings,
    };
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
