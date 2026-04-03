import { describe, expect, it } from 'vitest';
import {
  extractHashtagsFromActivityPubTags,
  extractHashtagsFromText,
  normalizeHashtag,
} from '../../utils/hashtags.js';

describe('FEP-eb48 hashtag parsing rules', () => {
  it('parses hashtags in all provided text examples', () => {
    const oneTagExamples = [
      '#hashtag',
      '"#hashtag"',
      ' #hashtag',
      '-#hashtag',
      '_#hashtag',
      '!#hashtag',
      '?#hashtag',
      '@#hashtag',
      ';#hashtag',
      ',#hashtag',
      ".'#hashtag",
      '[#hashtag',
      '&#hashtag',
      '^#hashtag',
    ];

    for (const example of oneTagExamples) {
      expect(extractHashtagsFromText(example)).toEqual(['hashtag']);
    }

    const twoTagExamples = [
      '(#hashtag/#hashtag)',
      '( #hashtag/#hashtag)',
      '( #hashtag /#hashtag)',
      '( #hashtag / #hashtag)',
    ];

    for (const example of twoTagExamples) {
      expect(extractHashtagsFromText(example)).toEqual(['hashtag']);
    }
  });

  it('accepts only valid hashtag grammar when normalizing', () => {
    expect(normalizeHashtag('#hashtag')).toBe('hashtag');
    expect(normalizeHashtag('#Hash_Tag2')).toBe('hash_tag2');

    expect(normalizeHashtag('hashtag')).toBeUndefined();
    expect(normalizeHashtag('#')).toBeUndefined();
    expect(normalizeHashtag('#_hashtag')).toBeUndefined();
    expect(normalizeHashtag('#hash-tag')).toBeUndefined();
  });

  it('can normalize query input with or without #', () => {
    expect(normalizeHashtag('#Hashtag', { allowMissingHash: true })).toBe('hashtag');
    expect(normalizeHashtag('Hashtag', { allowMissingHash: true })).toBe('hashtag');
    expect(normalizeHashtag('hash-tag', { allowMissingHash: true })).toBeUndefined();
  });

  it('extracts valid hashtag tags from AP tag objects', () => {
    const tags = [
      { type: 'Hashtag', name: '#Alpha' },
      { type: 'Hashtag', name: '#alpha' },
      { type: 'Hashtag', name: '#beta_2' },
      { type: 'Hashtag', name: '#bad-tag' },
      { type: 'Mention', name: '#ignored' },
      { type: 'Hashtag', name: 'missingPrefix' },
    ];

    expect(extractHashtagsFromActivityPubTags(tags)).toEqual(['alpha', 'beta_2']);
  });
});
