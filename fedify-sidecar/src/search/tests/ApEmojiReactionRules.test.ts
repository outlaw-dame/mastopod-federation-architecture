import { describe, expect, it } from 'vitest';
import {
  extractApEmojiReactionContent,
  isApEmojiReactionActivity,
} from '../../utils/apEmojiReactions.js';

describe('AP emoji reaction handling', () => {
  it('accepts EmojiReact with a single unicode grapheme', () => {
    const activity = {
      type: 'EmojiReact',
      content: '🔥',
      object: 'https://example.social/objects/1',
    };

    expect(isApEmojiReactionActivity(activity)).toBe(true);
    expect(extractApEmojiReactionContent(activity)).toBe('🔥');
  });

  it('accepts Like with shortcode reaction content', () => {
    const activity = {
      type: 'Like',
      content: ':blobwtfnotlikethis:',
      object: 'https://example.social/objects/2',
    };

    expect(isApEmojiReactionActivity(activity)).toBe(true);
    expect(extractApEmojiReactionContent(activity)).toBe(':blobwtfnotlikethis:');
  });

  it('rejects non-reaction content and invalid multi-grapheme payloads', () => {
    const invalidEmojiReact = {
      type: 'EmojiReact',
      content: 'ok',
    };

    const invalidLike = {
      type: 'Like',
      content: '🔥🔥',
    };

    expect(extractApEmojiReactionContent(invalidEmojiReact)).toBeUndefined();
    expect(extractApEmojiReactionContent(invalidLike)).toBeUndefined();
  });
});
