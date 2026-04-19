import type { CanonicalActorRef } from "./CanonicalActorRef.js";

export type CanonicalContentKind =
  | "note"
  | "article"
  | "profile"
  | "reaction"
  | "follow"
  | "share";

export type CanonicalBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "blockquote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string | null; text: string }
  | { type: "media"; attachmentId: string }
  | { type: "embed"; url: string };

export type CanonicalFacet =
  | { type: "mention"; label: string; target: CanonicalActorRef; start: number; end: number }
  | { type: "tag"; tag: string; start: number; end: number }
  | { type: "link"; url: string; start: number; end: number };

export type CanonicalAttachmentRole = "avatar" | "banner";

export interface CanonicalCustomEmoji {
  shortcode: string;
  emojiId?: string | null;
  iconUrl?: string | null;
  mediaType?: string | null;
  updatedAt?: string | null;
  alternateName?: string | null;
  domain?: string | null;
}

export interface CanonicalAttachment {
  attachmentId: string;
  mediaType: string;
  url?: string | null;
  cid?: string | null;
  byteSize?: number | null;
  duration?: string | number | null;
  digestMultibase?: string | null;
  role?: CanonicalAttachmentRole | null;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  focalPoint?: [number, number] | null;
  blurhash?: string | null;
}

export interface CanonicalLinkPreview {
  /** Canonical URL of the linked page. */
  uri: string;
  /** Page title (from og:title / <title>). */
  title: string;
  /** Short description (from og:description). */
  description?: string | null;
  /** Preview thumbnail image URL (from og:image). */
  thumbUrl?: string | null;
  /** Deprecated Mastodon-style single-author compatibility fields. */
  authorName?: string | null;
  authorUrl?: string | null;
  /** Mastodon-compatible preview authors, enriched with ActivityPods verification state. */
  authors?: CanonicalLinkPreviewAuthor[] | null;
}

export interface CanonicalLinkPreviewAuthorAccount {
  acct: string;
  uri?: string | null;
  url?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  attributionDomains?: string[];
}

export interface CanonicalLinkPreviewAuthor {
  name: string;
  url: string;
  handle?: string | null;
  account?: CanonicalLinkPreviewAuthorAccount | null;
  verified?: boolean;
  verificationState?: "verified" | "claimed";
  verificationReason?: string | null;
}

export interface CanonicalPollOption {
  /** The label text of this poll option. MUST be unique within a poll. */
  name: string;
  /** Number of votes for this option (0 when unknown). */
  voteCount: number;
}

export interface CanonicalContent {
  kind: CanonicalContentKind;
  title?: string | null;
  summary?: string | null;
  plaintext: string;
  html?: string | null;
  language?: string | null;
  blocks: CanonicalBlock[];
  facets: CanonicalFacet[];
  customEmojis?: CanonicalCustomEmoji[];
  attachments: CanonicalAttachment[];
  externalUrl?: string | null;
  /** Pre-fetched OpenGraph link preview for the primary URL in this content. */
  linkPreview?: CanonicalLinkPreview | null;
}

export function createParagraphBlocks(text: string): CanonicalBlock[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({ type: "paragraph" as const, text: paragraph }));
}
