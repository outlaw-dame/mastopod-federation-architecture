import { createHash } from "node:crypto";
import type {
  CanonicalPostCreateIntent,
  CanonicalPostDeleteIntent,
  CanonicalPostEditIntent,
} from "../../canonical/CanonicalIntent.js";
import type {
  CanonicalAttachment,
  CanonicalFacet,
  CanonicalLinkPreview,
} from "../../canonical/CanonicalContent.js";
import type { ProjectionCommandMetadata } from "../../ports/ProtocolBridgePorts.js";
import { canonicalFacetsToAtFacets, type AtFacet } from "../../text/CanonicalTextToAtFacets.js";

type CanonicalPostIntent =
  | CanonicalPostCreateIntent
  | CanonicalPostEditIntent
  | CanonicalPostDeleteIntent;

type CanonicalPostWriteIntent = CanonicalPostCreateIntent | CanonicalPostEditIntent;

export function buildPostMetadata(intent: CanonicalPostIntent): ProjectionCommandMetadata {
  return {
    canonicalIntentId: intent.canonicalIntentId,
    sourceProtocol: intent.sourceProtocol,
    provenance: intent.provenance,
  };
}

export function articleTeaserCanonicalRefId(canonicalObjectId: string): string {
  return `${canonicalObjectId}::teaser`;
}

export function deriveProjectedPostRkey(intent: CanonicalPostCreateIntent, suffix: string): string {
  return createHash("sha256")
    .update(`${intent.canonicalIntentId}:${suffix}`)
    .digest("hex")
    .slice(0, 13);
}

export function deriveArticleTeaserRkey(articleRkey: string): string {
  return createHash("sha256")
    .update(`article-teaser:${articleRkey}`)
    .digest("hex")
    .slice(0, 13);
}

export function buildArticleTeaser(intent: CanonicalPostWriteIntent): string {
  const parts = [intent.content.title, intent.content.summary]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const lead = parts.length > 0 ? parts.join(" — ") : intent.content.plaintext;
  const url = intent.content.linkPreview?.uri ?? intent.content.externalUrl ?? intent.object.canonicalUrl;
  const teaser = normalizeAtText(lead, 260);
  return url ? normalizeAtText(`${teaser}\n\n${url}`) : teaser;
}

export function buildTeaserAtFacets(
  teaserText: string,
  facets: readonly CanonicalFacet[],
  primaryUrl: string | null | undefined,
): AtFacet[] {
  const canonicalFacets = [...facets];
  const normalizedUrl = normalizeHttpUrl(primaryUrl);
  if (normalizedUrl) {
    const start = teaserText.lastIndexOf(normalizedUrl);
    const end = start >= 0 ? start + normalizedUrl.length : -1;
    const hasMatchingLink = canonicalFacets.some(
      (facet) =>
        facet.type === "link" &&
        facet.url === normalizedUrl &&
        facet.start === start &&
        facet.end === end,
    );
    if (start >= 0 && end > start && !hasMatchingLink) {
      canonicalFacets.push({
        type: "link",
        url: normalizedUrl,
        start,
        end,
      });
    }
  }

  return canonicalFacetsToAtFacets(teaserText, canonicalFacets);
}

export function buildExternalLinkEmbed(
  linkPreview: CanonicalLinkPreview | null | undefined,
): Record<string, unknown> | null {
  const uri = normalizeHttpUrl(linkPreview?.uri);
  const title = typeof linkPreview?.title === "string" ? linkPreview.title.trim().slice(0, 300) : "";
  if (!uri || !title) {
    return null;
  }

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri,
      title,
      description: typeof linkPreview?.description === "string"
        ? linkPreview.description.trim().slice(0, 1000)
        : "",
    },
  };
}

export function buildImageEmbedFromAttachments(
  attachments: readonly CanonicalAttachment[],
): Record<string, unknown> | null {
  const imageEntries = attachments
    .filter((attachment) => attachment.mediaType.toLowerCase().startsWith("image/"))
    .map((attachment) => {
      if (!attachment.cid || attachment.byteSize == null || attachment.byteSize < 0) {
        return null;
      }

      const imageEntry: Record<string, unknown> = {
        alt: normalizeAltText(attachment.alt),
        image: {
          $type: "blob",
          ref: {
            $link: attachment.cid,
          },
          mimeType: attachment.mediaType,
          size: Math.floor(attachment.byteSize),
        },
      };

      if (
        Number.isFinite(attachment.width)
        && Number.isFinite(attachment.height)
        && (attachment.width ?? 0) > 0
        && (attachment.height ?? 0) > 0
      ) {
        imageEntry["aspectRatio"] = {
          width: Math.floor(attachment.width!),
          height: Math.floor(attachment.height!),
        };
      }

      return imageEntry;
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .slice(0, 4);

  if (imageEntries.length === 0) {
    return null;
  }

  return {
    $type: "app.bsky.embed.images",
    images: imageEntries,
  };
}

export function normalizeAtText(value: string, limit = 3000): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const characters = Array.from(normalized);
  if (characters.length <= limit) {
    return normalized;
  }
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function parseAtUri(
  atUri: string | null | undefined,
  expectedDid: string,
): { collection: string; rkey: string } | null {
  if (!atUri) {
    return null;
  }

  const match = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match || match[1] !== expectedDid) {
    return null;
  }

  return {
    collection: match[2]!,
    rkey: match[3]!,
  };
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

function normalizeAltText(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  return normalized.length > 1000 ? `${normalized.slice(0, 999)}…` : normalized;
}
