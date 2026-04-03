export type AtRepoCollection =
  | 'app.bsky.actor.profile'
  | 'app.bsky.feed.post'
  | 'site.standard.document'
  | 'app.bsky.graph.follow'
  | 'app.bsky.feed.like'
  | 'app.bsky.feed.repost';

export interface AtRepoBridgeMetadata {
  canonicalIntentId: string;
  sourceProtocol: 'activitypub' | 'atproto';
  provenance: {
    originProtocol: 'activitypub' | 'atproto';
    originEventId: string;
    originAccountId?: string | null;
    mirroredFromCanonicalIntentId?: string | null;
    projectionMode: 'native' | 'mirrored';
  };
}

export interface AtRecordLocator {
  collection: AtRepoCollection;
  rkey: string;
}

export interface AtRepoOpV1 {
  did: string;
  canonicalAccountId: string;
  opId: string;
  opType: 'create' | 'update' | 'delete';
  collection: AtRepoCollection;
  rkey: string;
  canonicalRefId: string;
  record: unknown | null;
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface AtCommitV1 {
  did: string;
  canonicalAccountId: string;
  rev: string;
  commitCid: string;
  prevCommitCid: string | null;
  repoVersion: 3;
  ops: Array<{
    action: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    canonicalRefId?: string;
    uri?: string;
    cid?: string;
    subjectDid?: string | null;
    subjectUri?: string | null;
    subjectCid?: string | null;
    record?: Record<string, unknown> | null;
    bridge?: AtRepoBridgeMetadata;
  }>;
  emittedAt: string;
}

export interface AtEgressV1 {
  did: string;
  canonicalAccountId: string;
  kind: 'profile' | 'post' | 'article' | 'follow' | 'like' | 'repost';
  canonicalRefId: string;
  atUri?: string;
  cid?: string;
  emittedAt: string;
}
