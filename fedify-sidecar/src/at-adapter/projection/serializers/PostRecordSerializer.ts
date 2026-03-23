import { IdentityBinding } from '../../../core-domain/identity/IdentityBinding';
import { CanonicalPost } from '../AtProjectionPolicy';

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
  // Truncate to 3000 characters (ATProto limit)
  // Ensure it's valid UTF-8
  if (!text) return '';
  
  // A simple truncation for now, in a real app we'd need to be careful about grapheme clusters
  if (text.length > 3000) {
    return text.substring(0, 2997) + '...';
  }
  return text;
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
