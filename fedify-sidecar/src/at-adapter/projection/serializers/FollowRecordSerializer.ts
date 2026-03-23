/**
 * V6.5 Phase 5: Follow Record Serializer
 *
 * Serializes a CanonicalFollow into an app.bsky.graph.follow record.
 */

import { CanonicalFollow } from '../../events/AtSocialRepoEvents';

export interface AppBskyGraphFollowRecord {
  $type: 'app.bsky.graph.follow';
  subject: string;   // DID
  createdAt: string;
}

export interface FollowRecordSerializer {
  serialize(input: {
    follow: CanonicalFollow;
    subjectDid: string;
  }): AppBskyGraphFollowRecord;
}

export class DefaultFollowRecordSerializer implements FollowRecordSerializer {
  serialize(input: {
    follow: CanonicalFollow;
    subjectDid: string;
  }): AppBskyGraphFollowRecord {
    return {
      $type: 'app.bsky.graph.follow',
      subject: input.subjectDid,
      createdAt: input.follow.createdAt,
    };
  }
}
