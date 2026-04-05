import { IdentityBinding } from '../../../core-domain/identity/IdentityBinding';
import { CanonicalPost } from '../AtProjectionPolicy';
import { extractAtprotoTagsFromFacets } from '../../../utils/hashtags.js';
import { clampAtprotoText } from '../../../utils/emojis.js';

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface AppBskyFeedPostRecord {
  $type: 'app.bsky.feed.post';
  text: string;
  createdAt: string;
  langs?: string[];
  facets?: unknown[];
  tags?: string[];
  embed?: unknown;
  reply?: {
    root: StrongRef;
    parent: StrongRef;
  };
}

import { ReplyRefResolver } from './ReplyRefResolver';

export interface PostRecordSerializer {
  serialize(
    post: CanonicalPost,
    binding: IdentityBinding,
    deps: {
      facetBuilder: FacetBuilder;
      embedBuilder: EmbedBuilder;
      recordRefResolver: AtRecordRefResolver;
      replyRefResolver?: ReplyRefResolver;
    }
  ): Promise<AppBskyFeedPostRecord>;
}

export interface FacetBuilder {
  build(post: CanonicalPost): Promise<unknown[]>;
}

export interface EmbedBuilder {
  build(post: CanonicalPost, did: string): Promise<unknown | undefined>;
}

export interface AtRecordRefResolver {
  resolvePostStrongRef(canonicalPostId: string): Promise<StrongRef | null>;
}

export function normalizeAtPostText(text: string): string {
  return clampAtprotoText(text || '');
}

export class DefaultPostRecordSerializer implements PostRecordSerializer {
  async serialize(
    post: CanonicalPost,
    binding: IdentityBinding,
    deps: {
      facetBuilder: FacetBuilder;
      embedBuilder: EmbedBuilder;
      recordRefResolver: AtRecordRefResolver;
      replyRefResolver?: ReplyRefResolver;
    }
  ): Promise<AppBskyFeedPostRecord> {
    const text = normalizeAtPostText(post.bodyPlaintext);

    const record: AppBskyFeedPostRecord = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: post.publishedAt || new Date().toISOString(),
    };

    const facets = await deps.facetBuilder.build(post);
    if (facets && facets.length > 0) {
      record.facets = facets;

      // Keep a compact deduplicated tag list (max 8) in addition to facets.
      const tags = extractAtprotoTagsFromFacets(facets).slice(0, 8);
      if (tags.length > 0) {
        record.tags = tags;
      }
    }

    const embed = await deps.embedBuilder.build(post, binding.atprotoDid!);
    if (embed) {
      record.embed = embed;
    }

    if (deps.replyRefResolver && post.replyToCanonicalPostId) {
      const replyRefs = await deps.replyRefResolver.resolve(post);
      if (replyRefs) {
        record.reply = {
          root: replyRefs.root,
          parent: replyRefs.parent
        };
      }
    }

    return record;
  }
}
