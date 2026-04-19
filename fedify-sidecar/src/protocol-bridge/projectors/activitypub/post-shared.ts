import type {
  CanonicalInteractionPolicy,
  CanonicalPostCreateIntent,
  CanonicalPostDeleteIntent,
  CanonicalPostEditIntent,
  CanonicalPostInteractionPolicyUpdateIntent,
  CanonicalPollCreateIntent,
  CanonicalPollDeleteIntent,
  CanonicalPollEditIntent,
  CanonicalPollVoteAddIntent,
  CanonicalQuotePolicy,
  CanonicalReplyPolicy,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalLinkPreview } from "../../canonical/CanonicalContent.js";
import type { CanonicalObjectRef } from "../../canonical/CanonicalObjectRef.js";
import type { ActivityPubProjectionCommand } from "../../ports/ProtocolBridgePorts.js";
import { ACTIVITYSTREAMS_CONTEXT, LITEPUB_EMOJI_REACT_CONTEXT, MASTODON_EMOJI_CONTEXT } from "../../../utils/apCustomEmojis.js";

export const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";

const FEP1311_ATTACHMENT_CONTEXT = {
  digestMultibase: "https://w3id.org/security#digestMultibase",
  focalPoint: {
    "@id": "https://joinmastodon.org/ns#focalPoint",
    "@container": "@list",
  },
  blurhash: "http://joinmastodon.org/ns#blurhash",
};

/**
 * FEP-044f: Consent-respecting quote posts.
 * FEP-dd4b: Quote posts via Announce with commentary.
 *
 * Includes the primary FEP-044f `quote` property, compatibility aliases
 * (quoteUrl, quoteUri, _misskey_quote), the QuoteAuthorization/QuoteRequest
 * type declarations, and the GoToSocial interaction policy vocabulary for
 * advertising `canQuote` policies on all published objects.
 */
const FEP044F_QUOTE_CONTEXT: Record<string, unknown> = {
  // FEP-044f primary terms
  quote: {
    "@id": "https://w3id.org/fep/044f#quote",
    "@type": "@id",
  },
  quoteAuthorization: {
    "@id": "https://w3id.org/fep/044f#quoteAuthorization",
    "@type": "@id",
  },
  QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
  QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest",
  // Compatibility aliases (FEP-044f §Compatibility with other quote implementations)
  quoteUri: "http://fedibird.com/ns#quoteUri",
  _misskey_quote: "https://misskey-hub.net/ns/#_misskey_quote",
  // GoToSocial interaction policy vocabulary
  gts: "https://gotosocial.org/ns#",
  interactionPolicy: {
    "@id": "https://gotosocial.org/ns#interactionPolicy",
    "@type": "@id",
  },
  canReply: {
    "@id": "https://gotosocial.org/ns#canReply",
    "@type": "@id",
  },
  canQuote: {
    "@id": "https://gotosocial.org/ns#canQuote",
    "@type": "@id",
  },
  automaticApproval: {
    "@id": "https://gotosocial.org/ns#automaticApproval",
    "@type": "@id",
  },
  manualApproval: {
    "@id": "https://gotosocial.org/ns#manualApproval",
    "@type": "@id",
  },
  // GoToSocial interaction object properties (used in QuoteAuthorization/QuoteRequest)
  interactingObject: {
    "@id": "https://gotosocial.org/ns#interactingObject",
    "@type": "@id",
  },
  interactionTarget: {
    "@id": "https://gotosocial.org/ns#interactionTarget",
    "@type": "@id",
  },
};

type CanonicalPostIntent =
  | CanonicalPostCreateIntent
  | CanonicalPostEditIntent
  | CanonicalPostDeleteIntent
  | CanonicalPostInteractionPolicyUpdateIntent
  | CanonicalPollCreateIntent
  | CanonicalPollEditIntent
  | CanonicalPollDeleteIntent
  | CanonicalPollVoteAddIntent;

export function buildApActivityContext(
  options: {
    includeCustomEmojis?: boolean;
    includeEmojiReact?: boolean;
  } = {},
): Array<string | Record<string, unknown>> {
  return [
    ACTIVITYSTREAMS_CONTEXT,
    FEP1311_ATTACHMENT_CONTEXT,
    FEP044F_QUOTE_CONTEXT,
    ...(options.includeCustomEmojis ? [MASTODON_EMOJI_CONTEXT] : []),
    ...(options.includeEmojiReact ? [LITEPUB_EMOJI_REACT_CONTEXT] : []),
  ];
}

export function buildPostMetadata(intent: CanonicalPostIntent) {
  const noteLinkPreviewUrl =
    "content" in intent &&
    intent.content.kind === "note" &&
    typeof intent.content.linkPreview?.uri === "string"
      ? normalizeHttpUrl(intent.content.linkPreview.uri)
      : null;

  return {
    canonicalIntentId: intent.canonicalIntentId,
    sourceProtocol: intent.sourceProtocol,
    provenance: intent.provenance,
    ...(noteLinkPreviewUrl
      ? {
          activityPubHints: {
            noteLinkPreviewUrls: [noteLinkPreviewUrl],
          },
        }
      : {}),
  };
}

export function apTargetTopic(intent: CanonicalPostIntent): ActivityPubProjectionCommand["targetTopic"] {
  return intent.provenance.originProtocol === "atproto" ? "ap.atproto-ingress.v1" : "ap.outbound.v1";
}

export function resolveApObjectId(ref: CanonicalObjectRef): string {
  return toApIri(ref.activityPubObjectId ?? ref.canonicalUrl ?? ref.atUri ?? ref.canonicalObjectId);
}

export function resolveOptionalApObjectId(ref: CanonicalObjectRef | null | undefined): string | null {
  if (!ref) {
    return null;
  }

  return resolveApObjectId(ref);
}

export function buildApLinkPreviewIcon(
  linkPreview: CanonicalLinkPreview | null | undefined,
): Record<string, unknown> | null {
  const url = normalizeHttpUrl(linkPreview?.thumbUrl);
  if (!url) {
    return null;
  }

  const title = typeof linkPreview?.title === "string" ? linkPreview.title.trim() : "";
  return {
    type: "Image",
    url,
    ...(title ? { name: title.slice(0, 300) } : {}),
  };
}

export function buildApLinkPreviewCard(
  linkPreview: CanonicalLinkPreview | null | undefined,
): Record<string, unknown> | null {
  const url = normalizeHttpUrl(linkPreview?.uri);
  const title = typeof linkPreview?.title === "string" ? linkPreview.title.trim() : "";
  if (!url || !title) {
    return null;
  }

  const icon = buildApLinkPreviewIcon(linkPreview);
  const description = typeof linkPreview?.description === "string"
    ? linkPreview.description.trim()
    : "";

  return {
    type: "Document",
    mediaType: "text/html",
    url,
    name: title.slice(0, 300),
    ...(description ? { summary: description.slice(0, 1000) } : {}),
    ...(icon ? { icon } : {}),
  };
}

export function buildApArticlePreview(
  options: {
    title?: string | null;
    summary?: string | null;
    linkPreview?: CanonicalLinkPreview | null;
    attributedTo?: string | null;
    published?: string | null;
    updated?: string | null;
    tag?: Array<Record<string, unknown>> | null;
  },
): Record<string, unknown> | null {
  const titleText = normalizePreviewText(options.title);
  const summaryText = normalizePreviewText(options.summary);
  if (!titleText && !summaryText) {
    return null;
  }

  const contentParts: string[] = [];
  if (titleText) {
    contentParts.push(`<p><strong>${escapeHtml(titleText)}</strong></p>`);
  }
  if (summaryText) {
    contentParts.push(`<p>${escapeHtml(summaryText)}</p>`);
  }

  const preview: Record<string, unknown> = {
    type: "Note",
    content: contentParts.join(""),
  };

  const icon = buildApLinkPreviewIcon(options.linkPreview);
  if (icon) {
    preview["attachment"] = [icon];
  }
  if (options.attributedTo) {
    preview["attributedTo"] = options.attributedTo;
  }
  if (options.published) {
    preview["published"] = options.published;
  }
  if (options.updated) {
    preview["updated"] = options.updated;
  }
  if (Array.isArray(options.tag) && options.tag.length > 0) {
    preview["tag"] = options.tag;
  }

  return preview;
}

export function toApIri(value: string): string {
  return /^https?:\/\//.test(value) || value.startsWith("urn:") ? value : `urn:canonical:${encodeURIComponent(value)}`;
}

// ---------------------------------------------------------------------------
// AP interaction policy projection (GoToSocial vocabulary)
// ---------------------------------------------------------------------------

/**
 * Project a canonical interaction policy to the ActivityPub `interactionPolicy`
 * object (GoToSocial vocabulary, used by GTS and advertised on all published
 * Note/Article objects).
 *
 * Encoding rules:
 *   canReply "everyone"  → { automaticApproval: PUBLIC }
 *   canReply "followers" → { automaticApproval: "${actorId}/followers" }
 *   canReply "mentioned" → {} (empty — AP has no mentionRule equivalent)
 *   canReply "nobody"    → {} (empty — no automatic or manual approval)
 *   canQuote "everyone"  → { automaticApproval: PUBLIC }
 *   canQuote "nobody"    → {} (empty)
 *
 * Note: both "mentioned" and "nobody" produce an empty canReply object.  The
 * distinction exists only on ATProto (threadgate mentionRule vs. empty allow).
 */
export function buildApInteractionPolicy(
  policy: CanonicalInteractionPolicy | null | undefined,
  actorId: string,
): Record<string, unknown> {
  const canReply = buildApReplyApproval(policy?.canReply ?? "everyone", actorId);
  const canQuote = buildApQuoteApproval(policy?.canQuote ?? "everyone");
  return { canReply, canQuote };
}

function buildApReplyApproval(
  canReply: CanonicalReplyPolicy,
  actorId: string,
): Record<string, unknown> {
  switch (canReply) {
    case "everyone":
      return { automaticApproval: PUBLIC_AUDIENCE };
    case "followers":
      return { automaticApproval: `${actorId}/followers` };
    case "mentioned":
    case "nobody":
      // AP has no mentionRule equivalent; both restricted policies map to
      // an empty object (nobody gets automatic or manual approval).
      return {};
  }
}

function buildApQuoteApproval(canQuote: CanonicalQuotePolicy): Record<string, unknown> {
  switch (canQuote) {
    case "everyone":
      return { automaticApproval: PUBLIC_AUDIENCE };
    case "nobody":
      return {};
  }
}

function normalizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return parsed.toString();
}

function normalizePreviewText(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
