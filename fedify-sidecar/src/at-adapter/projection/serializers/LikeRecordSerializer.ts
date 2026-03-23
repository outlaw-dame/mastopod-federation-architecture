/**
 * V6.5 Phase 5: Like Record Serializer
 *
 * Serializes a CanonicalLike into an app.bsky.feed.like record.
 */

import { CanonicalLike } from '../../events/AtSocialRepoEvents';
import { StrongRef } from '../../repo/AtTargetAliasResolver';

export interface AppBskyFeedLikeRecord {
  $type: 'app.bsky.feed.like';
  subject: {
    uri: string;
    cid: string;
  };
  createdAt: string;
}

export interface LikeRecordSerializer {
  serialize(input: {
    like: CanonicalLike;
    target: StrongRef;
  }): AppBskyFeedLikeRecord;
}

export class DefaultLikeRecordSerializer implements LikeRecordSerializer {
  serialize(input: {
    like: CanonicalLike;
    target: StrongRef;
  }): AppBskyFeedLikeRecord {
    return {
      $type: 'app.bsky.feed.like',
      subject: {
        uri: input.target.uri,
        cid: input.target.cid,
      },
      createdAt: input.like.createdAt,
    };
  }
}
