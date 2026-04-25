const HASHTAG_HASH_RE = /^[#＃]/u;
const HASHTAG_SCAN_RE = /[#＃]([\p{L}\p{M}\p{N}\p{Pc}\u00B7\u30FB\u200C]+)/gu;
const HASHTAG_STRIP_URL_RE = /\bhttps?:\/\/[^\s<>'"]+/giu;
const HASHTAG_SEPARATOR_TRAILING_RE = /[\u00B7\u30FB\u200C]+$/gu;
const HASHTAG_INVALID_EDGE_RE = /^[^\p{L}\p{N}]|[^\p{L}\p{M}\p{N}\p{Pc}]$/u;
const HASHTAG_ALLOWED_BODY_RE = /^[\p{L}\p{M}\p{N}\p{Pc}\u00B7\u30FB\u200C]+$/u;
const HASHTAG_REQUIRES_LETTER_RE = /[\p{L}\p{M}]/u;
const ATPROTO_TRAILING_PUNCTUATION_RE = /[.,;:!?\)\]\}"'\u2019\u201d\u00bb]+$/gu;
const ATPROTO_TAG_GRAPHEME_MAX = 64;

function countGraphemes(input: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(input)).length;
  }
  return Array.from(input).length;
}

function normalizeHashtagBody(value: string): string | undefined {
  const normalized = value
    .normalize("NFKC")
    .replace(HASHTAG_SEPARATOR_TRAILING_RE, "");

  if (!normalized) {
    return undefined;
  }

  if (!HASHTAG_ALLOWED_BODY_RE.test(normalized)) {
    return undefined;
  }

  if (HASHTAG_INVALID_EDGE_RE.test(normalized)) {
    return undefined;
  }

  if (!HASHTAG_REQUIRES_LETTER_RE.test(normalized)) {
    return undefined;
  }

  return normalized.toLowerCase();
}

export function normalizeHashtag(
  value: string,
  options: { allowMissingHash?: boolean } = {}
): string | undefined {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  if (HASHTAG_HASH_RE.test(trimmed)) {
    return normalizeHashtagBody(trimmed.slice(1));
  }

  if (!options.allowMissingHash) {
    return undefined;
  }

  return normalizeHashtagBody(trimmed);
}

export function extractHashtagsFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  const source = text.replace(HASHTAG_STRIP_URL_RE, " ");
  const hashtags = new Set<string>();
  const matches = source.matchAll(HASHTAG_SCAN_RE);

  for (const match of matches) {
    const body = match[1];
    if (!body) {
      continue;
    }
    const normalized = normalizeHashtagBody(body);
    if (normalized) {
      hashtags.add(normalized);
    }
  }

  return Array.from(hashtags);
}

export function extractHashtagsFromActivityPubTags(tags: unknown): string[] {
  if (!tags) {
    return [];
  }

  const tagArray = Array.isArray(tags) ? tags : [tags];
  const hashtags = new Set<string>();

  for (const tag of tagArray) {
    if (!tag || typeof tag !== "object") {
      continue;
    }

    const tagRecord = tag as Record<string, unknown>;
    if (tagRecord["type"] !== "Hashtag" || typeof tagRecord["name"] !== "string") {
      continue;
    }

    const normalized = normalizeHashtag(tagRecord["name"]);
    if (normalized) {
      hashtags.add(normalized);
    }
  }

  return Array.from(hashtags);
}

export function normalizeAtprotoTag(value: string): string | undefined {
  const trimmed = value.trim().normalize("NFKC");
  if (!trimmed) {
    return undefined;
  }

  let normalized = trimmed;

  // ATProto facet tags usually omit '#'. For "double hash tags", retain one '#'.
  if (normalized.startsWith("##") || normalized.startsWith("＃＃")) {
    normalized = normalized.slice(1);
  } else if (normalized.startsWith("#") || normalized.startsWith("＃")) {
    normalized = normalized.slice(1);
  }

  normalized = normalized.trim().replace(ATPROTO_TRAILING_PUNCTUATION_RE, "");

  if (!normalized) {
    return undefined;
  }

  if (/\s/u.test(normalized)) {
    return undefined;
  }

  if (/^\d+$/u.test(normalized)) {
    return undefined;
  }

  if (countGraphemes(normalized) > ATPROTO_TAG_GRAPHEME_MAX) {
    return undefined;
  }

  return normalized.toLowerCase();
}

export function extractAtprotoTagsFromFacets(facets: unknown): string[] {
  if (!Array.isArray(facets)) {
    return [];
  }

  const tags = new Set<string>();

  for (const facet of facets) {
    if (!facet || typeof facet !== "object") {
      continue;
    }

    const features = (facet as { features?: unknown }).features;
    if (!Array.isArray(features)) {
      continue;
    }

    for (const feature of features) {
      if (!feature || typeof feature !== "object") {
        continue;
      }

      const featureRecord = feature as { $type?: unknown; tag?: unknown };
      if (
        featureRecord.$type !== "app.bsky.richtext.facet#tag" ||
        typeof featureRecord.tag !== "string"
      ) {
        continue;
      }

      const normalized = normalizeAtprotoTag(featureRecord.tag);
      if (normalized) {
        tags.add(normalized);
      }
    }
  }

  return Array.from(tags);
}

export function extractAtprotoTagsFromRecordTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  const normalizedTags = new Set<string>();

  for (const tag of tags) {
    if (typeof tag !== "string") {
      continue;
    }
    const normalized = normalizeAtprotoTag(tag);
    if (normalized) {
      normalizedTags.add(normalized);
    }
  }

  return Array.from(normalizedTags);
}
