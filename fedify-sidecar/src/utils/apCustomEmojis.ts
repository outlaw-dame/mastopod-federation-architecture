const SHORTCODE_BODY_RE = /^[A-Za-z0-9_+-]{1,64}$/;
const SHORTCODE_RE = /^:([A-Za-z0-9_+-]{1,64}):$/;
const EMOJI_TAG_TYPES = new Set([
  "Emoji",
  "toot:Emoji",
  "http://joinmastodon.org/ns#Emoji",
]);

type AnyRecord = Record<string, unknown>;

export interface ApCustomEmoji {
  shortcode: string;
  emojiId: string | null;
  iconUrl: string | null;
  mediaType: string | null;
  updatedAt: string | null;
  alternateName: string | null;
  domain: string | null;
}

export const ACTIVITYSTREAMS_CONTEXT = "https://www.w3.org/ns/activitystreams";
export const MASTODON_EMOJI_CONTEXT = {
  toot: "http://joinmastodon.org/ns#",
  Emoji: "toot:Emoji",
};
export const LITEPUB_EMOJI_REACT_CONTEXT = {
  litepub: "http://litepub.social/ns#",
  EmojiReact: "litepub:EmojiReact",
};

export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function normalizeShortcode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = trimmed.match(SHORTCODE_RE);
  if (direct) {
    return `:${direct[1]}:`;
  }

  if (SHORTCODE_BODY_RE.test(trimmed)) {
    return `:${trimmed}:`;
  }

  return null;
}

export function collectApCustomEmojis(
  rawTags: unknown,
  options: {
    referencedText?: readonly (string | null | undefined)[];
    fallbackDomain?: string | null;
  } = {},
): ApCustomEmoji[] {
  const emojis: ApCustomEmoji[] = [];
  const seen = new Set<string>();

  for (const rawTag of toArray(rawTags)) {
    const emoji = extractApCustomEmoji(rawTag, options);
    if (!emoji) {
      continue;
    }

    if (
      options.referencedText
      && options.referencedText.length > 0
      && !isShortcodeReferenced(options.referencedText, emoji.shortcode)
    ) {
      continue;
    }

    const fingerprint = `${emoji.shortcode.toLowerCase()}:${emoji.emojiId ?? ""}:${emoji.iconUrl ?? ""}`;
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    emojis.push(emoji);
  }

  return emojis;
}

export function extractApCustomEmoji(
  rawTag: unknown,
  options: {
    expectedShortcode?: string | null;
    fallbackDomain?: string | null;
  } = {},
): ApCustomEmoji | null {
  const tag = asObject(rawTag);
  if (!tag) {
    return null;
  }

  const rawType = asString(tag["type"]) ?? asString(tag["@type"]);
  if (!rawType || !EMOJI_TAG_TYPES.has(rawType)) {
    return null;
  }

  const shortcode = normalizeShortcode(tag["name"] ?? options.expectedShortcode);
  if (!shortcode) {
    return null;
  }

  if (
    options.expectedShortcode
    && shortcode.toLowerCase() !== options.expectedShortcode.toLowerCase()
  ) {
    return null;
  }

  const icon = asObject(tag["icon"]);
  const iconUrl = sanitizeHttpUrl(extractUrl(icon?.["url"]));
  const mediaType = sanitizeEmojiMediaType(icon?.["mediaType"]);
  const emojiId = sanitizeOpaqueId(asString(tag["id"]));
  const domain = deriveDomain(emojiId, options.fallbackDomain ?? null);

  return {
    shortcode,
    emojiId,
    iconUrl,
    mediaType,
    updatedAt: sanitizeTimestamp(asString(tag["updated"])),
    alternateName: sanitizeDisplayText(asString(tag["alternateName"])),
    domain,
  };
}

export function isShortcodeReferenced(
  references: readonly (string | null | undefined)[],
  shortcode: string,
): boolean {
  return references.some((reference) => typeof reference === "string" && reference.includes(shortcode));
}

export function sanitizeHttpUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    return null;
  }

  return parsed.toString();
}

export function sanitizeEmojiMediaType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith("image/")) {
    return null;
  }

  return trimmed;
}

function sanitizeOpaqueId(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) {
    return null;
  }

  return trimmed;
}

export function sanitizeTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

export function sanitizeDisplayText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed;
}

function deriveDomain(emojiId: string | null, fallbackDomain: string | null): string | null {
  const idDomain = deriveDomainFromUrl(emojiId);
  if (idDomain) {
    return idDomain;
  }

  return deriveDomainFromUrl(fallbackDomain) ?? fallbackDomain ?? null;
}

export function deriveDomainFromUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function extractUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractUrl(entry);
      if (url) {
        return url;
      }
    }
    return null;
  }

  const object = asObject(value);
  if (!object) {
    return null;
  }

  return asString(object["href"]);
}

function asObject(value: unknown): AnyRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as AnyRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
