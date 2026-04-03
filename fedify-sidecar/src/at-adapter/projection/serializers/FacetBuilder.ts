import { CanonicalPost } from '../AtProjectionPolicy';
import { normalizeAtprotoTag } from '../../../utils/hashtags.js';

interface AtRichtextFacetTag {
  $type: 'app.bsky.richtext.facet#tag';
  tag: string;
}

interface AtRichtextFacet {
  index: {
    byteStart: number;
    byteEnd: number;
  };
  features: AtRichtextFacetTag[];
}

export interface FacetBuilder {
  build(post: CanonicalPost): Promise<unknown[]>;
}

export class DefaultFacetBuilder implements FacetBuilder {
  async build(post: CanonicalPost): Promise<unknown[]> {
    const text = post.bodyPlaintext || '';
    if (!text) {
      return [];
    }

    const facets: AtRichtextFacet[] = [];
    const hashtagPattern = /##?[\p{L}\p{N}_]{1,64}/gu;

    for (const match of text.matchAll(hashtagPattern)) {
      if (match.index === undefined) {
        continue;
      }

      const rawHashtag = match[0];
      const normalized = normalizeAtprotoTag(rawHashtag);
      if (!normalized) {
        continue;
      }

      const byteStart = Buffer.byteLength(text.slice(0, match.index), 'utf8');
      const byteEnd = byteStart + Buffer.byteLength(rawHashtag, 'utf8');

      facets.push({
        index: {
          byteStart,
          byteEnd,
        },
        features: [
          {
            $type: 'app.bsky.richtext.facet#tag',
            tag: normalized,
          },
        ],
      });
    }

    return facets;
  }
}
