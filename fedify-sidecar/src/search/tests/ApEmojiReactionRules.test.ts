import { describe, expect, it } from 'vitest';
import {
  extractApEmojiReactionContent,
  isApEmojiReactionActivity,
  normalizeApEmojiReactionActivity,
  parseApEmojiReaction,
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

  it('normalizes EmojiReact shortcode reactions with a matching Emoji tag and context', () => {
    const activity = normalizeApEmojiReactionActivity({
      type: 'EmojiReact',
      content: ' :blobwtfnotlikethis: ',
      tag: [
        {
          type: 'Emoji',
          name: 'blobwtfnotlikethis',
          icon: {
            type: 'Image',
            mediaType: 'image/png',
            url: 'https://example.social/media/blobwtfnotlikethis.png',
          },
        },
      ],
    }) as Record<string, unknown>;

    const parsed = parseApEmojiReaction(activity);
    expect(parsed?.content).toBe(':blobwtfnotlikethis:');
    expect(parsed?.customEmoji?.shortcode).toBe(':blobwtfnotlikethis:');
    expect(parsed?.customEmoji?.iconUrl).toBe('https://example.social/media/blobwtfnotlikethis.png');
    expect(Array.isArray(activity['@context'])).toBe(true);
    expect((activity['tag'] as Array<Record<string, unknown>>)[0]?.['name']).toBe(':blobwtfnotlikethis:');
  });

  it('rejects shortcode emoji reactions without a single matching Emoji tag', () => {
    expect(parseApEmojiReaction({
      type: 'EmojiReact',
      content: ':blobwtfnotlikethis:',
      tag: [{ type: 'Mention', href: 'https://example.social/users/alice', name: '@alice' }],
    })).toBeNull();
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
