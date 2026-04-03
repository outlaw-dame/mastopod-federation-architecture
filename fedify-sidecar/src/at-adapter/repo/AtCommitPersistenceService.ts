import type { BuildCommitResult } from './AtCommitBuilder.js';
import type { AtAliasStore } from './AtAliasStore.js';
import type { AtCommitV1, AtEgressV1, AtRepoOpV1 } from '../events/AtRepoEvents.js';
import type { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';

export interface AtCommitPersistenceService {
  persist(result: BuildCommitResult): Promise<void>;
}

export class DefaultAtCommitPersistenceService implements AtCommitPersistenceService {
  constructor(
    private readonly aliasStore: AtAliasStore,
    private readonly eventPublisher: EventPublisher,
    private readonly redis: any // Redis client
  ) {}

  async persist(result: BuildCommitResult): Promise<void> {
    const now = new Date().toISOString();

    // 1. Write durable commit metadata to AtRepoStore (mocked for now)
    
    // 2. Update Redis repo head/rev/status
    const repoPrefix = `at:repo:${result.did}:`;
    await this.redis.set(`${repoPrefix}head`, result.commitCid);
    await this.redis.set(`${repoPrefix}rev`, result.rev);
    await this.redis.set(`${repoPrefix}status`, 'active');
    await this.redis.set(`${repoPrefix}lastCommitCid`, result.commitCid);
    await this.redis.set(`${repoPrefix}lastProjectionAt`, now);

    // 3. Update alias store for new/updated records
    for (const op of result.ops) {
      if (op.opType === 'create' || op.opType === 'update') {
        // Mock CID for the record itself
        const recordCid = 'bafyreimockrecordcid' + Date.now();
        await this.aliasStore.updateCidAndRev(op.canonicalRefId, recordCid, result.rev);
      } else if (op.opType === 'delete') {
        await this.aliasStore.markDeleted(op.canonicalRefId, now);
      }
    }

    // 4. Emit at.commit.v1
    const commitOps = await Promise.all(result.ops.map(async (op: AtRepoOpV1) => {
      const alias = await this.aliasStore.getByCanonicalRefId(op.canonicalRefId);
      return {
        action: op.opType,
        collection: op.collection,
        rkey: op.rkey,
        canonicalRefId: op.canonicalRefId,
        uri: `at://${result.did}/${op.collection}/${op.rkey}`,
        cid: 'bafyreimockrecordcid' + Date.now(), // Mock CID
        ...(typeof alias?.subjectDid === 'string' ? { subjectDid: alias.subjectDid } : {}),
        ...(typeof alias?.subjectUri === 'string' ? { subjectUri: alias.subjectUri } : {}),
        ...(typeof alias?.subjectCid === 'string' ? { subjectCid: alias.subjectCid } : {}),
        record: op.record as Record<string, unknown> | null | undefined,
        ...(op.bridge ? { bridge: op.bridge } : {})
      };
    }));

    const commitEvent: AtCommitV1 = {
      did: result.did,
      canonicalAccountId: result.ops[0]?.canonicalAccountId || 'unknown',
      rev: result.rev,
      commitCid: result.commitCid,
      prevCommitCid: result.prevCommitCid,
      repoVersion: 3,
      ops: commitOps,
      emittedAt: now
    };

    await this.eventPublisher.publish('at.commit.v1', commitEvent as any);

    // 5. Emit at.egress.v1 for each op
    for (const op of result.ops) {
      const egressEvent: AtEgressV1 = {
        did: result.did,
        canonicalAccountId: op.canonicalAccountId,
        kind:
          op.collection === 'app.bsky.actor.profile'
            ? 'profile'
            : op.collection === 'site.standard.document'
              ? 'article'
              : op.collection === 'app.bsky.graph.follow'
                ? 'follow'
                : op.collection === 'app.bsky.feed.like'
                  ? 'like'
                  : op.collection === 'app.bsky.feed.repost'
                    ? 'repost'
                    : 'post',
        canonicalRefId: op.canonicalRefId,
        atUri: `at://${result.did}/${op.collection}/${op.rkey}`,
        cid: 'bafyreimockrecordcid' + Date.now(), // Mock CID
        emittedAt: now
      };

      await this.eventPublisher.publish('at.egress.v1', egressEvent as any);
    }
  }
}
