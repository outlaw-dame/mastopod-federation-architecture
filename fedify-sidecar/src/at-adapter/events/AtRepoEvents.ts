export type AtRepoCollection =
  | 'app.bsky.actor.profile'
  | 'app.bsky.feed.post'
  | 'app.bsky.graph.follow'
  | 'app.bsky.feed.like'
  | 'app.bsky.feed.repost';

export interface AtRepoOpV1 {
  did: string;
  canonicalAccountId: string;
  opId: string;
  opType: 'create' | 'update' | 'delete';
  collection: AtRepoCollection;
  rkey: string;
  canonicalRefId: string;
  record: unknown | null;
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
    uri?: string;
    cid?: string;
  }>;
  emittedAt: string;
}

export interface AtEgressV1 {
  did: string;
  canonicalAccountId: string;
  kind: 'profile' | 'post' | 'follow' | 'like' | 'repost';
  canonicalRefId: string;
  atUri?: string;
  cid?: string;
  emittedAt: string;
}
