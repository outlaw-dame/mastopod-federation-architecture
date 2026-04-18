import { z } from "zod";
import type { CanonicalCustomEmoji } from "../../protocol-bridge/canonical/CanonicalContent.js";
import {
  deriveDomainFromUrl,
  normalizeShortcode,
  sanitizeDisplayText,
  sanitizeEmojiMediaType,
  sanitizeHttpUrl,
  sanitizeTimestamp,
} from "../../utils/apCustomEmojis.js";

const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
const AT_URI_RE = /^at:\/\/[^/]+\/[^/]+\/[^/]+$/;
const CID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{10,}$/;

export const ACTIVITYPODS_LEXICON_NAMESPACE = "org.activitypods";
export const ACTIVITYPODS_DEFS_LEXICON = "org.activitypods.defs";
export const ACTIVITYPODS_EMOJI_REACTION_COLLECTION = "org.activitypods.emojiReaction";
export const ACTIVITYPODS_CUSTOM_EMOJIS_FIELD = "activitypodsCustomEmojis";

export interface ActivityPodsRecordRef {
  uri: string;
  cid?: string | null;
}

export interface ActivityPodsEmojiIcon {
  uri: string;
  mediaType?: string | null;
}

export interface ActivityPodsEmojiDefinition {
  shortcode: string;
  emojiId?: string | null;
  icon?: ActivityPodsEmojiIcon | null;
  updatedAt?: string | null;
  alternateName?: string | null;
  domain?: string | null;
}

export interface ActivityPodsEmojiReactionRecord {
  $type: typeof ACTIVITYPODS_EMOJI_REACTION_COLLECTION;
  subject: ActivityPodsRecordRef;
  reaction: string;
  emoji?: ActivityPodsEmojiDefinition | null;
  createdAt?: string;
}

export const activityPodsRecordRefSchema = z.object({
  uri: z.string().regex(AT_URI_RE),
  cid: z.string().regex(CID_RE).optional().nullable(),
});

export const activityPodsEmojiIconSchema = z.object({
  uri: z.string().url(),
  mediaType: z.string().optional().nullable(),
});

export const activityPodsEmojiDefinitionSchema = z.object({
  shortcode: z.string().min(3).max(66),
  emojiId: z.string().url().optional().nullable(),
  icon: activityPodsEmojiIconSchema.optional().nullable(),
  updatedAt: z.string().optional().nullable(),
  alternateName: z.string().max(300).optional().nullable(),
  domain: z.string().max(255).optional().nullable(),
});

export const activityPodsEmbeddedCustomEmojiFieldSchema = z.array(
  activityPodsEmojiDefinitionSchema,
).max(128);

export const activityPodsEmojiReactionRecordSchema = z.object({
  $type: z.literal(ACTIVITYPODS_EMOJI_REACTION_COLLECTION),
  subject: activityPodsRecordRefSchema,
  reaction: z.string().min(1).max(128),
  emoji: activityPodsEmojiDefinitionSchema.optional().nullable(),
  createdAt: z.string().optional(),
});

export function buildActivityPodsCustomEmojiField(
  emojis: readonly CanonicalCustomEmoji[] | undefined,
): ActivityPodsEmojiDefinition[] | undefined {
  if (!emojis || emojis.length === 0) {
    return undefined;
  }

  const result: ActivityPodsEmojiDefinition[] = [];
  const seen = new Set<string>();
  for (const emoji of emojis) {
    const normalized = toActivityPodsEmojiDefinition(emoji);
    if (!normalized) {
      continue;
    }

    const fingerprint = [
      normalized.shortcode.toLowerCase(),
      normalized.emojiId ?? "",
      normalized.icon?.uri ?? "",
    ].join("|");
    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    result.push(normalized);
  }

  return result.length > 0 ? result : undefined;
}

export function parseActivityPodsCustomEmojiField(value: unknown): CanonicalCustomEmoji[] {
  const parsed = activityPodsEmbeddedCustomEmojiFieldSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  const result: CanonicalCustomEmoji[] = [];
  const seen = new Set<string>();
  for (const emoji of parsed.data) {
    const canonical = fromActivityPodsEmojiDefinition(emoji);
    if (!canonical) {
      continue;
    }

    const fingerprint = [
      canonical.shortcode.toLowerCase(),
      canonical.emojiId ?? "",
      canonical.iconUrl ?? "",
    ].join("|");
    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    result.push(canonical);
  }

  return result;
}

export function extractActivityPodsCustomEmojisFromRecord(
  record: Record<string, unknown>,
): CanonicalCustomEmoji[] {
  return parseActivityPodsCustomEmojiField(record[ACTIVITYPODS_CUSTOM_EMOJIS_FIELD]);
}

export function toActivityPodsEmojiDefinition(
  emoji: CanonicalCustomEmoji,
): ActivityPodsEmojiDefinition | null {
  const shortcode = normalizeShortcode(emoji.shortcode);
  if (!shortcode) {
    return null;
  }

  const emojiId = sanitizeOptionalUri(emoji.emojiId ?? null);
  const iconUri = sanitizeHttpUrl(emoji.iconUrl ?? null);
  const mediaType = sanitizeEmojiMediaType(emoji.mediaType ?? null);
  const domain = sanitizeDomain(emoji.domain ?? null)
    ?? deriveDomainFromUrl(emojiId)
    ?? deriveDomainFromUrl(iconUri)
    ?? null;

  return {
    shortcode,
    ...(emojiId ? { emojiId } : {}),
    ...(iconUri
      ? {
          icon: {
            uri: iconUri,
            ...(mediaType ? { mediaType } : {}),
          },
        }
      : {}),
    ...(sanitizeTimestamp(emoji.updatedAt ?? null) ? { updatedAt: sanitizeTimestamp(emoji.updatedAt ?? null)! } : {}),
    ...(sanitizeDisplayText(emoji.alternateName ?? null)
      ? { alternateName: sanitizeDisplayText(emoji.alternateName ?? null)! }
      : {}),
    ...(domain ? { domain } : {}),
  };
}

export function fromActivityPodsEmojiDefinition(
  emoji: ActivityPodsEmojiDefinition,
): CanonicalCustomEmoji | null {
  const shortcode = normalizeShortcode(emoji.shortcode);
  if (!shortcode) {
    return null;
  }

  const emojiId = sanitizeOptionalUri(emoji.emojiId ?? null);
  const iconUrl = sanitizeHttpUrl(emoji.icon?.uri ?? null);
  const mediaType = sanitizeEmojiMediaType(emoji.icon?.mediaType ?? null);
  const domain = sanitizeDomain(emoji.domain ?? null)
    ?? deriveDomainFromUrl(emojiId)
    ?? deriveDomainFromUrl(iconUrl)
    ?? null;

  return {
    shortcode,
    emojiId,
    iconUrl,
    mediaType,
    updatedAt: sanitizeTimestamp(emoji.updatedAt ?? null),
    alternateName: sanitizeDisplayText(emoji.alternateName ?? null),
    domain,
  };
}

export function normalizeActivityPodsReactionContent(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const shortcode = normalizeShortcode(trimmed);
  if (shortcode) {
    return shortcode;
  }

  const graphemes = splitGraphemes(trimmed);
  if (graphemes.length !== 1) {
    return null;
  }

  return EMOJI_GRAPHEME_RE.test(graphemes[0]!) ? graphemes[0]! : null;
}

export function parseActivityPodsEmojiReactionRecord(
  value: unknown,
): ActivityPodsEmojiReactionRecord | null {
  const parsed = activityPodsEmojiReactionRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const reaction = normalizeActivityPodsReactionContent(parsed.data.reaction);
  if (!reaction) {
    return null;
  }

  return {
    $type: ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
    subject: {
      uri: parsed.data.subject.uri,
      ...(parsed.data.subject.cid ? { cid: parsed.data.subject.cid } : {}),
    },
    reaction,
    ...(parsed.data.emoji ? { emoji: parsed.data.emoji } : {}),
    ...(sanitizeTimestamp(parsed.data.createdAt ?? null)
      ? { createdAt: sanitizeTimestamp(parsed.data.createdAt ?? null)! }
      : {}),
  };
}

function sanitizeOptionalUri(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeDomain(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255 || /[^a-z0-9.-]/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function splitGraphemes(input: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(input), (item) => item.segment);
  }

  return Array.from(input);
}
