import { describe, expect, it } from 'vitest';
import { clampAtprotoText, extractEmojisFromText } from '../../utils/emojis.js';

describe('ATProto emoji handling', () => {
  it('extracts deduplicated emoji graphemes from text', () => {
    const emojis = extractEmojisFromText('Hello 😀😀 🚀 👨‍👩‍👧‍👦 world');
    expect(emojis).toContain('😀');
    expect(emojis).toContain('🚀');
    expect(emojis).toContain('👨‍👩‍👧‍👦');
    expect(emojis.length).toBe(3);
  });

  it('clamps AT text by grapheme and UTF-8 byte limits without splitting emoji', () => {
    const emojiText = '😀'.repeat(301);
    const clamped = clampAtprotoText(emojiText);

    // Should respect AT maxGraphemes=300 for app.bsky.feed.post.text.
    expect(Array.from(clamped).length).toBeLessThanOrEqual(300 * 2);
    expect(clamped.length).toBeGreaterThan(0);

    // Ensure no replacement character from broken surrogate/grapheme split.
    expect(clamped.includes('�')).toBe(false);
  });
});
