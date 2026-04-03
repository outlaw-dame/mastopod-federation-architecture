import { AtProjectionPolicy, CanonicalProfile, CanonicalPost } from './AtProjectionPolicy.js';
import { ProfileRecordSerializer, ProfileMediaResolver } from './serializers/ProfileRecordSerializer.js';
import { PostRecordSerializer, FacetBuilder, EmbedBuilder } from './serializers/PostRecordSerializer.js';
import { StandardDocumentRecordSerializer } from './serializers/StandardDocumentRecordSerializer.js';
import { AtRecordRefResolver } from '../repo/AtRecordRefResolver.js';
import { AtCommitBuilder } from '../repo/AtCommitBuilder.js';
import { AtCommitPersistenceService } from '../repo/AtCommitPersistenceService.js';
import { AtRkeyService } from '../repo/AtRkeyService.js';
import { AtAliasStore, type AtAliasRecord } from '../repo/AtAliasStore.js';
import {
  AtRecordLocator,
  AtRepoBridgeMetadata,
  AtRepoCollection,
  AtRepoOpV1,
} from '../events/AtRepoEvents.js';
import { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import { AtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry.js';
import { EventPublisher } from '../../core-domain/events/CoreIdentityEvents.js';

export interface CoreProfileUpsertedV1 {
  profile: CanonicalProfile;
  identity: any; // CanonicalIdentity
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface CorePostCreatedV1 {
  canonicalPost: CanonicalPost;
  author: any; // CanonicalIdentity
  atRecord?: AtRecordLocator;
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface CorePostUpdatedV1 {
  canonicalPost: CanonicalPost;
  author: any; // CanonicalIdentity
  atRecord?: AtRecordLocator;
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface CorePostDeletedV1 {
  canonicalPostId: string;
  canonicalAuthorId: string;
  atRecord?: AtRecordLocator;
  bridge?: AtRepoBridgeMetadata;
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
} from '../events/AtSocialRepoEvents.js';
import { AtSubjectResolver } from '../identity/AtSubjectResolver.js';
import { AtTargetAliasResolver } from '../repo/AtTargetAliasResolver.js';
import { FollowRecordSerializer } from './serializers/FollowRecordSerializer.js';
import { LikeRecordSerializer } from './serializers/LikeRecordSerializer.js';
import { RepostRecordSerializer } from './serializers/RepostRecordSerializer.js';

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
    private readonly standardDocumentSerializer: StandardDocumentRecordSerializer,
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

  private async getOrCreateRepoState(did: string): Promise<any | null> {
    const existing = await this.repoRegistry.getRepoState(did);
    if (existing) return existing;

    const now = new Date().toISOString();
    const bootstrapState: any = {
      did,
      rootCid: null,
      rev: '0',
      collections: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.repoRegistry.register(bootstrapState);
    } catch {
      // Another request may have raced us; fall through and read current state.
    }

    return this.repoRegistry.getRepoState(did);
  }

  private async persistAndUpdateRepoState(repoState: any, commitResult: any): Promise<void> {
    await this.persistenceService.persist(commitResult);

    const updatedState: any = {
      ...repoState,
      rev: commitResult.rev,
      rootCid: commitResult.commitCid,
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.repoRegistry.update(updatedState);
    } catch {
      // Repo may have been removed/recreated concurrently; best-effort update only.
    }
  }

  async onProfileUpserted(event: CoreProfileUpsertedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.profile.id);
    if (!binding) return;

    const decision = this.policy.canProjectProfile(event.profile, binding);
    if (!decision.allowed) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
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
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);

    const now = new Date().toISOString();
    await this.aliasStore.put({
      canonicalRefId: event.profile.id,
      canonicalType: 'profile',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      cid: existingAlias?.cid ?? null,
      lastRev: existingAlias?.lastRev ?? null,
      createdAt: existingAlias?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    });

    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onPostCreated(event: CorePostCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalPost.authorId);
    if (!binding) return;

    const decision = this.policy.canProjectPost(event.canonicalPost, binding);
    if (!decision.allowed) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const isArticle = event.canonicalPost.kind === 'article';
    const record = isArticle
      ? await this.standardDocumentSerializer.serialize(event.canonicalPost, binding)
      : await this.postSerializer.serialize(event.canonicalPost, binding, this.deps);
    const collection = isArticle ? 'site.standard.document' : 'app.bsky.feed.post';
    const rkey = this.getRequestedRkey(event.atRecord, collection)
      ?? this.rkeyService.postRkey(event.canonicalPost.publishedAt);

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.canonicalPost.id,
      record,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    
    // Save alias before persist so it has the right URI
    await this.aliasStore.put({
      canonicalRefId: event.canonicalPost.id,
      canonicalType: isArticle ? 'article' : 'post',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      canonicalUrl: event.canonicalPost.canonicalUrl ?? this.defaultCanonicalUrl(collection, binding.atprotoDid!, rkey),
      activityPubObjectId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onPostUpdated(event: CorePostUpdatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalPost.authorId);
    if (!binding) return;

    const decision = this.policy.canProjectPost(event.canonicalPost, binding);
    if (!decision.allowed) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const alias = await this.ensureAliasForLocator(
      event.canonicalPost.id,
      event.canonicalPost.kind === 'article' ? 'site.standard.document' : 'app.bsky.feed.post',
      event.canonicalPost.kind === 'article' ? 'article' : 'post',
      binding.atprotoDid!,
      event.atRecord,
    );
    if (!alias) return;

    const record = alias.collection === 'site.standard.document'
      ? await this.standardDocumentSerializer.serialize(event.canonicalPost, binding)
      : await this.postSerializer.serialize(event.canonicalPost, binding, this.deps);

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'update',
      collection: alias.collection,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalPost.id,
      record,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    await this.aliasStore.put({
      ...alias,
      canonicalUrl: event.canonicalPost.canonicalUrl
        ?? alias.canonicalUrl
        ?? this.defaultCanonicalUrl(alias.collection, binding.atprotoDid!, alias.rkey),
      updatedAt: new Date().toISOString(),
    });
    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onPostDeleted(event: CorePostDeletedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalAuthorId);
    if (!binding) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const alias = await this.ensureAliasForLocator(
      event.canonicalPostId,
      event.atRecord?.collection,
      this.canonicalTypeForCollection(event.atRecord?.collection),
      binding.atprotoDid!,
      event.atRecord,
    );
    if (!alias) return;

    const op: AtRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalPostId,
      record: null,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);

    const commitResult = await this.commitBuilder.buildCommit(repoState, [op]);
    await this.persistAndUpdateRepoState(repoState, commitResult);
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

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = this.deps.followSerializer.serialize({
      follow: event.follow,
      subjectDid
    });

    const collection = 'app.bsky.graph.follow';
    const rkey = this.getRequestedRkey(event.atRecord, collection)
      ?? this.rkeyService.postRkey(event.follow.createdAt);

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.follow.id,
      record,
      ...(event.bridge ? { bridge: event.bridge } : {}),
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

    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onFollowDeleted(event: CoreFollowDeletedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.followerCanonicalId);
    if (!binding) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const alias = await this.ensureAliasForLocator(
      event.canonicalFollowId,
      'app.bsky.graph.follow',
      'follow',
      binding.atprotoDid!,
      event.atRecord,
    );
    if (!alias) return;

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection as any,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalFollowId,
      record: null,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);
    
    await this.persistAndUpdateRepoState(repoState, commitResult);
    await this.aliasStore.markDeleted(event.canonicalFollowId, event.deletedAt);
  }

  async onLikeCreated(event: CoreLikeCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.actor.id);
    if (!binding) return;
    
    const decision = this.policy.canProjectSocialAction(binding);
    if (!decision.allowed) return;

    const targetRef = await this.deps.targetAliasResolver.resolvePostStrongRef(event.targetPost.id);
    if (!targetRef) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = this.deps.likeSerializer.serialize({
      like: event.like,
      target: targetRef
    });

    const collection = 'app.bsky.feed.like';
    const rkey = this.getRequestedRkey(event.atRecord, collection)
      ?? this.rkeyService.postRkey(event.like.createdAt);

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.like.id,
      record,
      ...(event.bridge ? { bridge: event.bridge } : {}),
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

    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onLikeDeleted(event: CoreLikeDeletedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalActorId);
    if (!binding) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const alias = await this.ensureAliasForLocator(
      event.canonicalLikeId,
      'app.bsky.feed.like',
      'like',
      binding.atprotoDid!,
      event.atRecord,
    );
    if (!alias) return;

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection as any,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalLikeId,
      record: null,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);
    
    await this.persistAndUpdateRepoState(repoState, commitResult);
    await this.aliasStore.markDeleted(event.canonicalLikeId, event.deletedAt);
  }

  async onRepostCreated(event: CoreRepostCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.actor.id);
    if (!binding) return;
    
    const decision = this.policy.canProjectSocialAction(binding);
    if (!decision.allowed) return;

    const targetRef = await this.deps.targetAliasResolver.resolvePostStrongRef(event.targetPost.id);
    if (!targetRef) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const record = this.deps.repostSerializer.serialize({
      repost: event.repost,
      target: targetRef
    });

    const collection = 'app.bsky.feed.repost';
    const rkey = this.getRequestedRkey(event.atRecord, collection)
      ?? this.rkeyService.postRkey(event.repost.createdAt);

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.repost.id,
      record,
      ...(event.bridge ? { bridge: event.bridge } : {}),
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

    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onRepostDeleted(event: CoreRepostDeletedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalActorId);
    if (!binding) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const alias = await this.ensureAliasForLocator(
      event.canonicalRepostId,
      'app.bsky.feed.repost',
      'repost',
      binding.atprotoDid!,
      event.atRecord,
    );
    if (!alias) return;

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'delete',
      collection: alias.collection as any,
      rkey: alias.rkey,
      canonicalRefId: event.canonicalRepostId,
      record: null,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString()
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);
    
    await this.persistAndUpdateRepoState(repoState, commitResult);
    await this.aliasStore.markDeleted(event.canonicalRepostId, event.deletedAt);
  }

  private getRequestedRkey(
    atRecord: AtRecordLocator | undefined,
    expectedCollection: AtRepoCollection,
  ): string | null {
    if (!atRecord || atRecord.collection !== expectedCollection) {
      return null;
    }
    return atRecord.rkey;
  }

  private canonicalTypeForCollection(
    collection: AtRepoCollection | undefined,
  ): AtAliasRecord['canonicalType'] | null {
    switch (collection) {
      case 'app.bsky.actor.profile':
        return 'profile';
      case 'site.standard.document':
        return 'article';
      case 'app.bsky.graph.follow':
        return 'follow';
      case 'app.bsky.feed.like':
        return 'like';
      case 'app.bsky.feed.repost':
        return 'repost';
      case 'app.bsky.feed.post':
        return 'post';
      default:
        return null;
    }
  }

  private async ensureAliasForLocator(
    canonicalRefId: string,
    expectedCollection: AtRepoCollection | undefined,
    canonicalType: AtAliasRecord['canonicalType'] | null,
    did: string,
    atRecord?: AtRecordLocator,
  ): Promise<AtAliasRecord | null> {
    const existingAlias = await this.aliasStore.getByCanonicalRefId(canonicalRefId);
    if (existingAlias && !existingAlias.deletedAt) {
      return existingAlias;
    }
    if (!expectedCollection || !canonicalType || !atRecord || atRecord.collection !== expectedCollection) {
      return null;
    }

    const now = new Date().toISOString();
    const placeholder: AtAliasRecord = {
      canonicalRefId,
      canonicalType,
      did,
      collection: expectedCollection,
      rkey: atRecord.rkey,
      atUri: `at://${did}/${expectedCollection}/${atRecord.rkey}`,
      cid: existingAlias?.cid ?? null,
      lastRev: existingAlias?.lastRev ?? null,
      createdAt: existingAlias?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      subjectDid: existingAlias?.subjectDid ?? null,
      subjectUri: existingAlias?.subjectUri ?? null,
      subjectCid: existingAlias?.subjectCid ?? null,
      canonicalUrl: existingAlias?.canonicalUrl ?? null,
      activityPubObjectId: existingAlias?.activityPubObjectId ?? null,
    };
    await this.aliasStore.put(placeholder);
    return placeholder;
  }

  private defaultCanonicalUrl(
    collection: AtRepoCollection,
    did: string,
    rkey: string,
  ): string | null {
    if (collection !== 'app.bsky.feed.post') {
      return null;
    }
    return `https://bsky.app/profile/${did}/post/${rkey}`;
  }
}
