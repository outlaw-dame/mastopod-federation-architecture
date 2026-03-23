export interface AtRepoOpV1 {
  did: string;
  canonicalAccountId: string;
  opId: string;
  opType: 'create' | 'update' | 'delete';
  collection: 'app.bsky.actor.profile' | 'app.bsky.feed.post';
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
  kind: 'profile' | 'post';
  canonicalRefId: string;
  atUri?: string;
  cid?: string;
  emittedAt: string;
}
