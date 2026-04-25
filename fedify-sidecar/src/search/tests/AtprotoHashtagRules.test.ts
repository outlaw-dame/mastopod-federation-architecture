import { describe, expect, it } from 'vitest';
import {
  extractAtprotoTagsFromFacets,
  normalizeAtprotoTag,
} from '../../utils/hashtags.js';
import { DefaultFacetBuilder } from '../../at-adapter/projection/serializers/FacetBuilder.js';

describe('ATProto hashtag handling', () => {
  it('normalizes facet tags per AT conventions', () => {
    expect(normalizeAtprotoTag('Tag')).toBe('tag');
    expect(normalizeAtprotoTag('#Tag')).toBe('tag');
    expect(normalizeAtprotoTag('##Tag')).toBe('#tag');
    expect(normalizeAtprotoTag('＃タグ')).toBe('タグ');
    expect(normalizeAtprotoTag('#Привет')).toBe('привет');
    expect(normalizeAtprotoTag('#world!!!')).toBe('world');
    expect(normalizeAtprotoTag('#12345')).toBeUndefined();
  });

  it('extracts tags from facets and normalizes them', () => {
    const facets = [
      {
        index: { byteStart: 0, byteEnd: 4 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'News' }],
      },
      {
        index: { byteStart: 5, byteEnd: 10 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: '#Tech' }],
      },
      {
        index: { byteStart: 11, byteEnd: 16 },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
      },
      {
        index: { byteStart: 17, byteEnd: 21 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'ぼっち・ざ・ろっく' }],
      },
      {
        index: { byteStart: 22, byteEnd: 28 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: '＃Привет' }],
      },
    ];

    expect(extractAtprotoTagsFromFacets(facets)).toEqual([
      'news',
      'tech',
      'ぼっち・ざ・ろっく',
      'привет',
    ]);
  });

  it('builds hashtag facets with UTF-8 byte indices', async () => {
    const builder = new DefaultFacetBuilder();
    const post = {
      id: 'post-1',
      authorId: 'author-1',
      bodyPlaintext: 'Hello #World from #ATProto',
      visibility: 'public',
      publishedAt: new Date().toISOString(),
    };

    const facets = await builder.build(post as any);

    expect(facets.length).toBe(2);
    expect((facets[0] as any).features[0].tag).toBe('world');
    expect((facets[1] as any).features[0].tag).toBe('atproto');

    const first = facets[0] as any;
    expect(first.index.byteStart).toBe(6);
    expect(first.index.byteEnd).toBe(12);
  });

  it('builds facets for multilingual tags and excludes pure-digit tags', async () => {
    const builder = new DefaultFacetBuilder();
    const post = {
      id: 'post-2',
      authorId: 'author-1',
      bodyPlaintext: 'Mix #ぼっち・ざ・ろっく #Привет #1234',
      visibility: 'public',
      publishedAt: new Date().toISOString(),
    };

    const facets = await builder.build(post as any);
    const tags = facets.map(f => (f as any).features[0].tag);

    expect(tags).toEqual(['ぼっち・ざ・ろっく', 'привет']);
  });
});
