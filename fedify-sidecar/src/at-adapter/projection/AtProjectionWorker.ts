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

import {
  CoreFollowCreatedV1,
  CoreFollowDeletedV1,
  CoreLikeCreatedV1,
  CoreLikeDeletedV1,
  CoreRepostCreatedV1,
  CoreRepostDeletedV1,
  AtSocialRepoOpV1
} from '../events/AtSocialRepoEvents';
import { AtSubjectResolver } from '../identity/AtSubjectResolver';
import { AtTargetAliasResolver } from '../repo/AtTargetAliasResolver';
import { FollowRecordSerializer } from './serializers/FollowRecordSerializer';
import { LikeRecordSerializer } from './serializers/LikeRecordSerializer';
import { RepostRecordSerializer } from './serializers/RepostRecordSerializer';

export interface AtProjectionWorker {
  onProfileUpserted(event: CoreProfileUpsertedV1): Promise<void>;
  onPostCreated(event: CorePostCreatedV1): Promise<void>;
  onPostUpdated(event: CorePostUpdatedV1): Promise<void>;
  onPostDeleted(event: CorePostDeletedV1): Promise<void>;
  
  onFollowCreated(event: CoreFollowCreatedV1): Promise<void>;
  onFollowDeleted(event: CoreFollowDeletedV1): Promise<void>;
  onLikeCreated(event: CoreLikeCreatedV1): Promise<void>;
  onLikeDeleted(event: CoreLikeDeletedV1): Promise<void>;
  onRepostCreated(event: CoreRepostCreatedV1): Promise<void>;
  onRepostDeleted(event: CoreRepostDeletedV1): Promise<void>;
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
      replyRefResolver?: any;
      subjectResolver: AtSubjectResolver;
      targetAliasResolver: AtTargetAliasResolver;
      followSerializer: FollowRecordSerializer;
      likeSerializer: LikeRecordSerializer;
      repostSerializer: RepostRecordSerializer;
    }
  ) {}

  async onProfileUpserted(event: CoreProfileUpsertedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.profile.id);
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
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalPost.authorId);
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

    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalPost.authorId);
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

    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalAuthorId);
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

  // ---------------------------------------------------------------------------
  // Social Actions (Phase 5)
  // ---------------------------------------------------------------------------

  async onFollowCreated(event: CoreFollowCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.follower.id);
    if (!binding) return;
    
    const decision = this.policy.canProjectSocialAction(binding);
    if (!decision.allowed) return;

    const subjectDid = await this.deps.subjectResolver.resolveDidForIdentity(event.followed);
    if (!subjectDid) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = this.deps.followSerializer.serialize({
      follow: event.follow,
      subjectDid
    });

    const rkey = this.rkeyService.postRkey(event.follow.createdAt); // Use TID
    const collection = 'app.bsky.graph.follow';

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.follow.id,
      record,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);

    await this.aliasStore.put({
      canonicalRefId: event.follow.id,
      canonicalType: 'follow',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      subjectDid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await this.persistenceService.persist(commitResult);
  }

  async onFollowDeleted(event: CoreFollowDeletedV1): Promise<void> {
    const alias = await this.aliasStore.getByCanonicalRefId(event.canonicalFollowId);
    if (!alias) return;

    const binding = await this.identityRepo.getByCanonicalAccountId(event.followerCanonicalId);
    if (!binding) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection as any,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalFollowId,
      record: null,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);
    
    await this.persistenceService.persist(commitResult);
    await this.aliasStore.markDeleted(event.canonicalFollowId, event.deletedAt);
  }

  async onLikeCreated(event: CoreLikeCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.actor.id);
    if (!binding) return;
    
    const decision = this.policy.canProjectSocialAction(binding);
    if (!decision.allowed) return;

    const targetRef = await this.deps.targetAliasResolver.resolvePostStrongRef(event.targetPost.id);
    if (!targetRef) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = this.deps.likeSerializer.serialize({
      like: event.like,
      target: targetRef
    });

    const rkey = this.rkeyService.postRkey(event.like.createdAt);
    const collection = 'app.bsky.feed.like';

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.like.id,
      record,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);

    await this.aliasStore.put({
      canonicalRefId: event.like.id,
      canonicalType: 'like',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      subjectUri: targetRef.uri,
      subjectCid: targetRef.cid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await this.persistenceService.persist(commitResult);
  }

  async onLikeDeleted(event: CoreLikeDeletedV1): Promise<void> {
    const alias = await this.aliasStore.getByCanonicalRefId(event.canonicalLikeId);
    if (!alias) return;

    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalActorId);
    if (!binding) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection as any,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalLikeId,
      record: null,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);
    
    await this.persistenceService.persist(commitResult);
    await this.aliasStore.markDeleted(event.canonicalLikeId, event.deletedAt);
  }

  async onRepostCreated(event: CoreRepostCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.actor.id);
    if (!binding) return;
    
    const decision = this.policy.canProjectSocialAction(binding);
    if (!decision.allowed) return;

    const targetRef = await this.deps.targetAliasResolver.resolvePostStrongRef(event.targetPost.id);
    if (!targetRef) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = this.deps.repostSerializer.serialize({
      repost: event.repost,
      target: targetRef
    });

    const rkey = this.rkeyService.postRkey(event.repost.createdAt);
    const collection = 'app.bsky.feed.repost';

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.repost.id,
      record,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);

    await this.aliasStore.put({
      canonicalRefId: event.repost.id,
      canonicalType: 'repost',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      subjectUri: targetRef.uri,
      subjectCid: targetRef.cid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await this.persistenceService.persist(commitResult);
  }

  async onRepostDeleted(event: CoreRepostDeletedV1): Promise<void> {
    const alias = await this.aliasStore.getByCanonicalRefId(event.canonicalRepostId);
    if (!alias) return;

    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalActorId);
    if (!binding) return;

    const repoState = await this.repoRegistry.getRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection as any,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalRepostId,
      record: null,
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);
    
    await this.persistenceService.persist(commitResult);
    await this.aliasStore.markDeleted(event.canonicalRepostId, event.deletedAt);
  }
}
