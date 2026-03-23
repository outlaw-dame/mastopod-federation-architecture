import { AtProjectionPolicy, CanonicalProfile, CanonicalPost } from './AtProjectionPolicy';
import { ProfileRecordSerializer, ProfileMediaResolver } from './serializers/ProfileRecordSerializer';
import { PostRecordSerializer, FacetBuilder, EmbedBuilder } from './serializers/PostRecordSerializer';
import { AtRecordRefResolver } from '../repo/AtRecordRefResolver';
import { AtCommitBuilder } from '../repo/AtCommitBuilder';
import { AtCommitPersistenceService } from '../repo/AtCommitPersistenceService';
import { AtRkeyService } from '../repo/AtRkeyService';
import { AtAliasStore } from '../repo/AtAliasStore';
import { AtRepoOpV1 } from '../events/AtRepoEvents';
import { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository';
import { AtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents';

export interface CoreProfileUpsertedV1 {
  profile: CanonicalProfile;
  identity: any; // CanonicalIdentity
  emittedAt: string;
}

export interface CorePostCreatedV1 {
  canonicalPost: CanonicalPost;
  author: any; // CanonicalIdentity
  emittedAt: string;
}

export interface CorePostUpdatedV1 {
  canonicalPost: CanonicalPost;
  author: any; // CanonicalIdentity
  emittedAt: string;
}

export interface CorePostDeletedV1 {
  canonicalPostId: string;
  canonicalAuthorId: string;
  deletedAt: string;
  emittedAt: string;
}

export interface AtProjectionWorker {
  onProfileUpserted(event: CoreProfileUpsertedV1): Promise<void>;
  onPostCreated(event: CorePostCreatedV1): Promise<void>;
  onPostUpdated(event: CorePostUpdatedV1): Promise<void>;
  onPostDeleted(event: CorePostDeletedV1): Promise<void>;
}

export class DefaultAtProjectionWorker implements AtProjectionWorker {
  constructor(
    private readonly policy: AtProjectionPolicy,
    private readonly identityRepo: IdentityBindingRepository,
    private readonly repoRegistry: AtprotoRepoRegistry,
    private readonly profileSerializer: ProfileRecordSerializer,
    private readonly postSerializer: PostRecordSerializer,
    private readonly rkeyService: AtRkeyService,
    private readonly aliasStore: AtAliasStore,
    private readonly commitBuilder: AtCommitBuilder,
    private readonly persistenceService: AtCommitPersistenceService,
    private readonly eventPublisher: EventPublisher,
    private readonly deps: {
      mediaResolver: ProfileMediaResolver;
      facetBuilder: FacetBuilder;
      embedBuilder: EmbedBuilder;
      recordRefResolver: AtRecordRefResolver;
    }
  ) {}

  async onProfileUpserted(event: CoreProfileUpsertedV1): Promise<void> {
    const binding = await this.identityRepo.findByCanonicalId(event.profile.id);
    if (!binding) return;

    const decision = this.policy.canProjectProfile(event.profile, binding);
    if (!decision.allowed) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = await this.profileSerializer.serialize(event.profile, binding, this.deps.mediaResolver);
    const rkey = this.rkeyService.profileRkey();
    const collection = 'app.bsky.actor.profile';

    const existingAlias = await this.aliasStore.getByCanonicalRefId(event.profile.id);
    const opType = existingAlias ? 'update' : 'create';

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType,
      collection,
      rkey,
      canonicalRefId: event.profile.id,
      record,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    await this.persistenceService.persist(commitResult);
  }

  async onPostCreated(event: CorePostCreatedV1): Promise<void> {
    const binding = await this.identityRepo.findByCanonicalId(event.canonicalPost.authorId);
    if (!binding) return;

    const decision = this.policy.canProjectPost(event.canonicalPost, binding);
    if (!decision.allowed) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = await this.postSerializer.serialize(event.canonicalPost, binding, this.deps);
    const rkey = this.rkeyService.postRkey(event.canonicalPost.publishedAt);
    const collection = 'app.bsky.feed.post';

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.canonicalPost.id,
      record,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    
    // Save alias before persist so it has the right URI
    await this.aliasStore.put({
      canonicalRefId: event.canonicalPost.id,
      canonicalType: 'post',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await this.persistenceService.persist(commitResult);
  }

  async onPostUpdated(event: CorePostUpdatedV1): Promise<void> {
    const alias = await this.aliasStore.getByCanonicalRefId(event.canonicalPost.id);
    if (!alias) return;

    const binding = await this.identityRepo.findByCanonicalId(event.canonicalPost.authorId);
    if (!binding) return;

    const decision = this.policy.canProjectPost(event.canonicalPost, binding);
    if (!decision.allowed) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = await this.postSerializer.serialize(event.canonicalPost, binding, this.deps);

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'update',
      collection: alias.collection,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalPost.id,
      record,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    await this.persistenceService.persist(commitResult);
  }

  async onPostDeleted(event: CorePostDeletedV1): Promise<void> {
    const alias = await this.aliasStore.getByCanonicalRefId(event.canonicalPostId);
    if (!alias) return;

    const binding = await this.identityRepo.findByCanonicalId(event.canonicalAuthorId);
    if (!binding) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalPostId,
      record: null,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    await this.persistenceService.persist(commitResult);
  }
}
