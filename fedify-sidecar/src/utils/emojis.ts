const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

function splitGraphemes(input: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(input), item => item.segment);
  }
  return Array.from(input);
}

function isEmojiGrapheme(grapheme: string): boolean {
  return EMOJI_GRAPHEME_RE.test(grapheme);
}

export function extractEmojisFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  const emojis = new Set<string>();
  const graphemes = splitGraphemes(text);

  for (const grapheme of graphemes) {
    if (isEmojiGrapheme(grapheme)) {
      emojis.add(grapheme);
    }
  }

  return Array.from(emojis);
}

export function clampAtprotoText(text: string): string {
  if (!text) {
    return '';
  }

  const MAX_GRAPHEMES = 300;
  const MAX_UTF8_BYTES = 3000;

  const graphemes = splitGraphemes(text);
  let result = '';
  let graphemeCount = 0;

  for (const grapheme of graphemes) {
    if (graphemeCount >= MAX_GRAPHEMES) {
      break;
    }

    const candidate = result + grapheme;
    if (Buffer.byteLength(candidate, 'utf8') > MAX_UTF8_BYTES) {
      break;
    }

    result = candidate;
    graphemeCount += 1;
  }

  return result;
}
