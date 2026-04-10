import type {
  CanonicalPostCreateIntent,
  CanonicalPostDeleteIntent,
  CanonicalPostEditIntent,
} from "../../canonical/CanonicalIntent.js";
import type { CanonicalLinkPreview } from "../../canonical/CanonicalContent.js";
import type { CanonicalObjectRef } from "../../canonical/CanonicalObjectRef.js";
import type { ActivityPubProjectionCommand } from "../../ports/ProtocolBridgePorts.js";

export const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";

const FEP1311_ATTACHMENT_CONTEXT = {
  digestMultibase: "https://w3id.org/security#digestMultibase",
  focalPoint: {
    "@id": "https://joinmastodon.org/ns#focalPoint",
    "@container": "@list",
  },
  blurhash: "http://joinmastodon.org/ns#blurhash",
};

type CanonicalPostIntent =
  | CanonicalPostCreateIntent
  | CanonicalPostEditIntent
  | CanonicalPostDeleteIntent;

export function buildApActivityContext(): Array<string | Record<string, unknown>> {
  return [
    "https://www.w3.org/ns/activitystreams",
    FEP1311_ATTACHMENT_CONTEXT,
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

export function toApIri(value: string): string {
  return /^https?:\/\//.test(value) || value.startsWith("urn:") ? value : `urn:canonical:${encodeURIComponent(value)}`;
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
