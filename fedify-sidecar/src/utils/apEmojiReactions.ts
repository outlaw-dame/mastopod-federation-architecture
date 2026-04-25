import {
  ACTIVITYSTREAMS_CONTEXT,
  LITEPUB_EMOJI_REACT_CONTEXT,
  extractApCustomEmoji,
  normalizeShortcode,
  toArray,
  type ApCustomEmoji,
} from "./apCustomEmojis.js";

const SHORTCODE_RE = /^:([A-Za-z0-9_+-]{1,64}):$/;
const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

type AnyRecord = Record<string, unknown>;

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

export interface ApEmojiReaction {
  content: string;
  customEmoji: ApCustomEmoji | null;
  normalizedActivity: Record<string, unknown>;
  emittedType: "Like" | "EmojiReact";
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

export function parseApEmojiReaction(activity: unknown): ApEmojiReaction | null {
  if (!isApEmojiReactionActivity(activity)) {
    return null;
  }

  const apActivity = activity as AnyRecord;
  const normalizedContent = extractApEmojiReactionContent(apActivity);
  if (!normalizedContent) {
    return null;
  }

  const shortcode = normalizeShortcode(normalizedContent);
  const normalizedTags = normalizeEmojiReactionTags(apActivity["tag"], shortcode);
  if (shortcode && !normalizedTags) {
    return null;
  }

  const normalizedActivity: Record<string, unknown> = shortcode
    ? {
        ...apActivity,
        content: normalizedContent,
        tag: normalizedTags,
      }
    : {
        ...apActivity,
        content: normalizedContent,
      };

  const emittedType = hasType(
    apActivity,
    'EmojiReact',
    'litepub:EmojiReact',
    'http://litepub.social/ns#EmojiReact',
  )
    ? "EmojiReact"
    : "Like";

  return {
    content: normalizedContent,
    customEmoji: shortcode
      ? extractApCustomEmoji(normalizedTags?.[0] ?? null, { expectedShortcode: shortcode })
      : null,
    normalizedActivity: ensureEmojiReactContext(normalizedActivity),
    emittedType,
  };
}

export function normalizeApEmojiReactionActivity(activity: unknown): unknown {
  if (!isApEmojiReactionActivity(activity)) {
    return activity;
  }

  const apActivity = activity as AnyRecord;
  const normalizedContent = extractApEmojiReactionContent(apActivity);
  if (!normalizedContent) {
    return activity;
  }

  const shortcode = normalizeShortcode(normalizedContent);
  const normalizedTags = normalizeEmojiReactionTags(apActivity["tag"], shortcode);
  if (shortcode && !normalizedTags) {
    return activity;
  }

  const nextActivity: Record<string, unknown> = shortcode
    ? {
        ...apActivity,
        content: normalizedContent,
        tag: normalizedTags,
      }
    : {
        ...apActivity,
        content: normalizedContent,
      };

  return ensureEmojiReactContext(nextActivity);
}

function ensureEmojiReactContext(activity: Record<string, unknown>): Record<string, unknown> {
  if (
    !hasType(
      activity,
      'EmojiReact',
      'litepub:EmojiReact',
      'http://litepub.social/ns#EmojiReact',
    )
  ) {
    return activity;
  }

  const contexts = toArray(activity["@context"]);
  const hasAsContext = contexts.some(entry => entry === ACTIVITYSTREAMS_CONTEXT);
  const hasLitepubContext = contexts.some(
    entry =>
      entry
      && typeof entry === "object"
      && !Array.isArray(entry)
      && (entry as AnyRecord)["EmojiReact"] === "litepub:EmojiReact",
  );
  if (hasAsContext && hasLitepubContext) {
    return activity;
  }

  const nextContext = [...contexts];
  if (!hasAsContext) {
    nextContext.unshift(ACTIVITYSTREAMS_CONTEXT);
  }
  if (!hasLitepubContext) {
    nextContext.push(LITEPUB_EMOJI_REACT_CONTEXT);
  }

  return {
    ...activity,
    "@context": nextContext,
  };
}

function normalizeEmojiReactionTags(tags: unknown, shortcode: string | null): Array<Record<string, unknown>> | null {
  if (!shortcode) {
    return null;
  }

  const tagList = toArray(tags);
  if (tagList.length !== 1) {
    return null;
  }

  const normalizedTag = normalizeCustomEmojiTag(tagList[0], shortcode);
  return normalizedTag ? [normalizedTag] : null;
}

function normalizeCustomEmojiTag(tag: unknown, shortcode: string): Record<string, unknown> | null {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) {
    return null;
  }

  const emojiTag = tag as AnyRecord;
  const type = emojiTag["type"] ?? emojiTag["@type"];
  if (
    type !== "Emoji"
    && type !== "toot:Emoji"
    && type !== "http://joinmastodon.org/ns#Emoji"
  ) {
    return null;
  }

  const normalizedName = normalizeShortcode(emojiTag["name"] ?? shortcode);
  if (!normalizedName || normalizedName.toLowerCase() !== shortcode.toLowerCase()) {
    return null;
  }

  return {
    ...emojiTag,
    type: "Emoji",
    name: shortcode,
  };
}
