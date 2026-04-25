/**
 * V6.5 Phase 5: Repost Record Serializer
 *
 * Serializes a CanonicalRepost into an app.bsky.feed.repost record.
 */

import type { CanonicalRepost } from '../../events/AtSocialRepoEvents.js';
import type { StrongRef } from '../../repo/AtTargetAliasResolver.js';

export interface AppBskyFeedRepostRecord {
  $type: 'app.bsky.feed.repost';
  subject: {
    uri: string;
    cid: string;
  };
  createdAt: string;
}

export interface RepostRecordSerializer {
  serialize(input: {
    repost: CanonicalRepost;
    target: StrongRef;
  }): AppBskyFeedRepostRecord;
}

export class DefaultRepostRecordSerializer implements RepostRecordSerializer {
  serialize(input: {
    repost: CanonicalRepost;
    target: StrongRef;
  }): AppBskyFeedRepostRecord {
    return {
      $type: 'app.bsky.feed.repost',
      subject: {
        uri: input.target.uri,
        cid: input.target.cid,
      },
      createdAt: input.repost.createdAt,
    };
  }
}
