const SHORTCODE_BODY_RE = /^[A-Za-z0-9_+-]{1,64}$/;
const SHORTCODE_RE = /^:([A-Za-z0-9_+-]{1,64}):$/;
const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

type AnyRecord = Record<string, unknown>;

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function splitGraphemes(input: string): string[] {
  if (!input) {
    return [];
  }

  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(input), item => item.segment);
  }

  return Array.from(input);
}

function normalizeShortcode(value: unknown): string | null {
  if (typeof value !== 'string') {
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

function normalizeDirectShortcode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = trimmed.match(SHORTCODE_RE);
  return direct ? `:${direct[1]}:` : null;
}

function normalizeUnicodeEmoji(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const graphemes = splitGraphemes(trimmed);
  if (graphemes.length !== 1) {
    return null;
  }

  const first = graphemes[0];
  if (!first) {
    return null;
  }

  return EMOJI_GRAPHEME_RE.test(first) ? first : null;
}

function hasType(activity: AnyRecord, ...allowedTypes: string[]): boolean {
  const types = toArray(activity["type"] ?? activity['@type']);
  return types.some(type => typeof type === 'string' && allowedTypes.includes(type));
}

export function isApEmojiReactionActivity(activity: unknown): boolean {
  if (!activity || typeof activity !== 'object') {
    return false;
  }

  const apActivity = activity as AnyRecord;

  if (
    hasType(
      apActivity,
      'EmojiReact',
      'litepub:EmojiReact',
      'http://litepub.social/ns#EmojiReact'
    )
  ) {
    return true;
  }

  return hasType(apActivity, 'Like', 'as:Like', 'https://www.w3.org/ns/activitystreams#Like')
    && typeof apActivity["content"] === 'string'
    && apActivity["content"].trim().length > 0;
}

export function extractApEmojiReactionContent(activity: unknown): string | undefined {
  if (!isApEmojiReactionActivity(activity)) {
    return undefined;
  }

  const apActivity = activity as AnyRecord;
  const shortcode = hasType(
    apActivity,
    'EmojiReact',
    'litepub:EmojiReact',
    'http://litepub.social/ns#EmojiReact'
  )
    ? normalizeDirectShortcode(apActivity["content"])
    : normalizeShortcode(apActivity["content"]);
  if (shortcode) {
    return shortcode;
  }

  const unicodeEmoji = normalizeUnicodeEmoji(apActivity["content"]);
  if (unicodeEmoji) {
    return unicodeEmoji;
  }

  return undefined;
}
