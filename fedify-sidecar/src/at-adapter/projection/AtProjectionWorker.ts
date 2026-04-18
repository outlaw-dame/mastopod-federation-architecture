import { createHash } from 'node:crypto';
import { AtProjectionPolicy, CanonicalProfile, CanonicalPost } from './AtProjectionPolicy.js';
import { ProfileRecordSerializer, ProfileMediaResolver } from './serializers/ProfileRecordSerializer.js';
import { PostRecordSerializer, FacetBuilder, EmbedBuilder } from './serializers/PostRecordSerializer.js';
import { StandardDocumentRecordSerializer } from './serializers/StandardDocumentRecordSerializer.js';
import {
  DefaultEmojiReactionRecordSerializer,
  type EmojiReactionRecordSerializer,
} from './serializers/EmojiReactionRecordSerializer.js';
import {
  ArticleTeaserRecordSerializer,
  DefaultArticleTeaserRecordSerializer,
} from './serializers/ArticleTeaserRecordSerializer.js';
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
import {
  ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
  parseActivityPodsEmojiReactionRecord,
  toActivityPodsEmojiDefinition,
} from '../lexicon/ActivityPodsEmojiLexicon.js';

export interface CoreProfileUpsertedV1 {
  profile: CanonicalProfile;
  identity: any; // CanonicalIdentity
  nativeRecord?: Record<string, unknown>;
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface CorePostCreatedV1 {
  canonicalPost: CanonicalPost;
  author: any; // CanonicalIdentity
  atRecord?: AtRecordLocator;
  nativeRecord?: Record<string, unknown>;
  generateTeaserCompanion?: boolean;
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface CorePostUpdatedV1 {
  canonicalPost: CanonicalPost;
  author: any; // CanonicalIdentity
  atRecord?: AtRecordLocator;
  nativeRecord?: Record<string, unknown>;
  generateTeaserCompanion?: boolean;
  bridge?: AtRepoBridgeMetadata;
  emittedAt: string;
}

export interface CorePostDeletedV1 {
  canonicalPostId: string;
  canonicalAuthorId: string;
  atRecord?: AtRecordLocator;
  generateTeaserCompanion?: boolean;
  bridge?: AtRepoBridgeMetadata;
  deletedAt: string;
  emittedAt: string;
}

import {
  CoreEmojiReactionCreatedV1,
  CoreEmojiReactionDeletedV1,
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
  
  onEmojiReactionCreated(event: CoreEmojiReactionCreatedV1): Promise<void>;
  onEmojiReactionDeleted(event: CoreEmojiReactionDeletedV1): Promise<void>;
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
      articleTeaserSerializer?: ArticleTeaserRecordSerializer;
      recordRefResolver: AtRecordRefResolver;
      replyRefResolver?: any;
      subjectResolver: AtSubjectResolver;
      targetAliasResolver: AtTargetAliasResolver;
      followSerializer: FollowRecordSerializer;
      likeSerializer: LikeRecordSerializer;
      repostSerializer: RepostRecordSerializer;
      emojiReactionSerializer?: EmojiReactionRecordSerializer;
    }
  ) {
    this.articleTeaserSerializer = deps.articleTeaserSerializer ?? new DefaultArticleTeaserRecordSerializer();
    this.emojiReactionSerializer = deps.emojiReactionSerializer ?? new DefaultEmojiReactionRecordSerializer();
  }

  private readonly articleTeaserSerializer: ArticleTeaserRecordSerializer;
  private readonly emojiReactionSerializer: EmojiReactionRecordSerializer;

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

    const serializedRecord = await this.profileSerializer.serialize(event.profile, binding, this.deps.mediaResolver);
    const record = event.nativeRecord && this.isNativeRecordForCollection(event.nativeRecord, 'app.bsky.actor.profile')
      ? {
          ...serializedRecord,
          ...cloneNativeRecord(event.nativeRecord),
        }
      : serializedRecord;
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
    const collection = isArticle ? 'site.standard.document' : 'app.bsky.feed.post';
    const record = event.nativeRecord && this.isNativeRecordForCollection(event.nativeRecord, collection)
      ? cloneNativeRecord(event.nativeRecord)
      : isArticle
        ? await this.standardDocumentSerializer.serialize(event.canonicalPost, binding)
        : await this.postSerializer.serialize(event.canonicalPost, binding, this.deps);
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
    const ops: AtRepoOpV1[] = [op];
    const teaserAlias = isArticle && event.generateTeaserCompanion
      ? buildArticleTeaserAlias(event.canonicalPost.id, binding.atprotoDid!, rkey)
      : null;
    if (teaserAlias) {
      ops.push({
        did: binding.atprotoDid!,
        canonicalAccountId: binding.canonicalAccountId,
        opId: `op-${Date.now()}-teaser`,
        opType: 'create',
        collection: 'app.bsky.feed.post',
        rkey: teaserAlias.rkey,
        canonicalRefId: teaserAlias.canonicalRefId,
        record: await this.articleTeaserSerializer.serialize(event.canonicalPost, binding, {
          embedBuilder: this.deps.embedBuilder,
        }),
        ...(event.bridge ? { bridge: event.bridge } : {}),
        emittedAt: new Date().toISOString(),
      });
    }

    for (const pendingOp of ops) {
      await this.eventPublisher.publish('at.repo.op.v1', pendingOp as any);
    }

    const commitResult = await this.commitBuilder.buildCommit(repoState, ops);
    
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
    if (teaserAlias) {
      await this.aliasStore.put({
        canonicalRefId: teaserAlias.canonicalRefId,
        canonicalType: 'post',
        did: binding.atprotoDid!,
        collection: 'app.bsky.feed.post',
        rkey: teaserAlias.rkey,
        atUri: teaserAlias.atUri,
        canonicalUrl: teaserAlias.canonicalUrl,
        activityPubObjectId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

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

    const record = event.nativeRecord && this.isNativeRecordForCollection(event.nativeRecord, alias.collection)
      ? cloneNativeRecord(event.nativeRecord)
      : alias.collection === 'site.standard.document'
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
    const ops: AtRepoOpV1[] = [op];
    let teaserAlias: AtAliasRecord | null = null;
    if (alias.collection === 'site.standard.document' && event.generateTeaserCompanion) {
      teaserAlias = await this.ensureArticleTeaserAlias(
        event.canonicalPost.id,
        binding.atprotoDid!,
        alias.rkey,
      );
      if (teaserAlias) {
        ops.push({
          did: binding.atprotoDid!,
          canonicalAccountId: binding.canonicalAccountId,
          opId: `op-${Date.now()}-teaser`,
          opType: 'update',
          collection: 'app.bsky.feed.post',
          rkey: teaserAlias.rkey,
          canonicalRefId: teaserAlias.canonicalRefId,
          record: await this.articleTeaserSerializer.serialize(event.canonicalPost, binding, {
            embedBuilder: this.deps.embedBuilder,
          }),
          ...(event.bridge ? { bridge: event.bridge } : {}),
          emittedAt: new Date().toISOString(),
        });
      }
    }

    for (const pendingOp of ops) {
      await this.eventPublisher.publish('at.repo.op.v1', pendingOp as any);
    }

    const commitResult = await this.commitBuilder.buildCommit(repoState, ops);
    await this.aliasStore.put({
      ...alias,
      canonicalUrl: event.canonicalPost.canonicalUrl
        ?? alias.canonicalUrl
        ?? this.defaultCanonicalUrl(alias.collection, binding.atprotoDid!, alias.rkey),
      updatedAt: new Date().toISOString(),
    });
    if (teaserAlias) {
      await this.aliasStore.put({
        ...teaserAlias,
        updatedAt: new Date().toISOString(),
      });
    }
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
    const ops: AtRepoOpV1[] = [op];
    let teaserAlias: AtAliasRecord | null = null;
    if (alias.collection === 'site.standard.document' && event.generateTeaserCompanion) {
      teaserAlias = await this.ensureArticleTeaserAlias(
        event.canonicalPostId,
        binding.atprotoDid!,
        alias.rkey,
      );
      if (teaserAlias) {
        ops.push({
          did: binding.atprotoDid!,
          canonicalAccountId: binding.canonicalAccountId,
          opId: `op-${Date.now()}-teaser`,
          opType: 'delete',
          collection: 'app.bsky.feed.post',
          rkey: teaserAlias.rkey,
          canonicalRefId: teaserAlias.canonicalRefId,
          record: null,
          ...(event.bridge ? { bridge: event.bridge } : {}),
          emittedAt: new Date().toISOString(),
        });
      }
    }

    for (const pendingOp of ops) {
      await this.eventPublisher.publish('at.repo.op.v1', pendingOp as any);
    }

    const commitResult = await this.commitBuilder.buildCommit(repoState, ops);
    await this.persistAndUpdateRepoState(repoState, commitResult);
    await this.aliasStore.markDeleted(event.canonicalPostId, event.deletedAt);
    if (teaserAlias) {
      await this.aliasStore.markDeleted(teaserAlias.canonicalRefId, event.deletedAt);
    }
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

  async onEmojiReactionCreated(event: CoreEmojiReactionCreatedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.actor.id);
    if (!binding) return;

    const decision = this.policy.canProjectSocialAction(binding);
    if (!decision.allowed) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const targetRecord = event.nativeRecord
      ? parseActivityPodsEmojiReactionRecord(event.nativeRecord)
      : null;
    const targetRef = targetRecord?.subject?.uri
      ? {
          uri: targetRecord.subject.uri,
          cid: targetRecord.subject.cid ?? null,
        }
      : await this.deps.targetAliasResolver.resolvePostStrongRef(event.targetPost.id);
    if (!targetRef?.uri) return;

    const record = targetRecord ?? this.emojiReactionSerializer.serialize({
      reaction: event.reaction,
      target: targetRef,
    });

    const collection = ACTIVITYPODS_EMOJI_REACTION_COLLECTION;
    const rkey = this.getRequestedRkey(event.atRecord, collection)
      ?? this.rkeyService.postRkey(event.reaction.createdAt);

    const op: AtSocialRepoOpV1 = {
      did: binding.atprotoDid!,
      canonicalAccountId: binding.canonicalAccountId,
      opId: `op-${Date.now()}`,
      opType: 'create',
      collection,
      rkey,
      canonicalRefId: event.reaction.id,
      record,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString(),
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);

    await this.aliasStore.put({
      canonicalRefId: event.reaction.id,
      canonicalType: 'emojiReaction',
      did: binding.atprotoDid!,
      collection,
      rkey,
      atUri: `at://${binding.atprotoDid}/${collection}/${rkey}`,
      ...(targetRef.uri ? { subjectUri: targetRef.uri } : {}),
      ...(targetRef.cid ? { subjectCid: targetRef.cid } : {}),
      reactionContent: event.reaction.content,
      reactionEmoji: event.reaction.emoji
        ? toActivityPodsEmojiDefinition(event.reaction.emoji)
        : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await this.persistAndUpdateRepoState(repoState, commitResult);
  }

  async onEmojiReactionDeleted(event: CoreEmojiReactionDeletedV1): Promise<void> {
    const binding = await this.identityRepo.getByCanonicalAccountId(event.canonicalActorId);
    if (!binding) return;

    const repoState = await this.getOrCreateRepoState(binding.atprotoDid!);
    if (!repoState) return;

    const alias = await this.ensureAliasForLocator(
      event.canonicalReactionId,
      ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
      'emojiReaction',
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
      canonicalRefId: event.canonicalReactionId,
      record: null,
      ...(event.bridge ? { bridge: event.bridge } : {}),
      emittedAt: new Date().toISOString(),
    };

    await this.eventPublisher.publish('at.repo.op.v1', op as any);
    const commitResult = await this.commitBuilder.buildCommit(repoState, [op as any]);

    await this.persistAndUpdateRepoState(repoState, commitResult);
    await this.aliasStore.markDeleted(event.canonicalReactionId, event.deletedAt);
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
      case ACTIVITYPODS_EMOJI_REACTION_COLLECTION:
        return 'emojiReaction';
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
      reactionContent: existingAlias?.reactionContent ?? null,
      reactionEmoji: existingAlias?.reactionEmoji ?? null,
      canonicalUrl: existingAlias?.canonicalUrl ?? null,
      activityPubObjectId: existingAlias?.activityPubObjectId ?? null,
    };
    await this.aliasStore.put(placeholder);
    return placeholder;
  }

  private async ensureArticleTeaserAlias(
    articleCanonicalRefId: string,
    did: string,
    articleRkey: string,
  ): Promise<AtAliasRecord | null> {
    const teaserAlias = buildArticleTeaserAlias(articleCanonicalRefId, did, articleRkey);
    const existingAlias = await this.aliasStore.getByCanonicalRefId(teaserAlias.canonicalRefId);
    if (existingAlias && !existingAlias.deletedAt) {
      return existingAlias;
    }

    const now = new Date().toISOString();
    await this.aliasStore.put({
      canonicalRefId: teaserAlias.canonicalRefId,
      canonicalType: 'post',
      did,
      collection: 'app.bsky.feed.post',
      rkey: teaserAlias.rkey,
      atUri: teaserAlias.atUri,
      cid: existingAlias?.cid ?? null,
      lastRev: existingAlias?.lastRev ?? null,
      createdAt: existingAlias?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      subjectDid: existingAlias?.subjectDid ?? null,
      subjectUri: existingAlias?.subjectUri ?? null,
      subjectCid: existingAlias?.subjectCid ?? null,
      reactionContent: existingAlias?.reactionContent ?? null,
      reactionEmoji: existingAlias?.reactionEmoji ?? null,
      canonicalUrl: existingAlias?.canonicalUrl ?? teaserAlias.canonicalUrl,
      activityPubObjectId: existingAlias?.activityPubObjectId ?? null,
    });
    return await this.aliasStore.getByCanonicalRefId(teaserAlias.canonicalRefId);
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

  private isNativeRecordForCollection(
    record: Record<string, unknown>,
    collection: AtRepoCollection,
  ): boolean {
    const type = typeof record['$type'] === 'string' ? record['$type'] : null;
    return (
      (collection === 'app.bsky.actor.profile' && type === 'app.bsky.actor.profile') ||
      (collection === 'app.bsky.feed.post' && type === 'app.bsky.feed.post') ||
      (collection === 'site.standard.document' && type === 'site.standard.document') ||
      (collection === ACTIVITYPODS_EMOJI_REACTION_COLLECTION && type === ACTIVITYPODS_EMOJI_REACTION_COLLECTION)
    );
  }
}

function cloneNativeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function buildArticleTeaserAlias(
  articleCanonicalRefId: string,
  did: string,
  articleRkey: string,
): Pick<AtAliasRecord, 'canonicalRefId' | 'rkey' | 'atUri' | 'canonicalUrl'> {
  const teaserRkey = createHash('sha256')
    .update(`article-teaser:${articleRkey}`)
    .digest('hex')
    .slice(0, 13);
  return {
    canonicalRefId: `${articleCanonicalRefId}::teaser`,
    rkey: teaserRkey,
    atUri: `at://${did}/app.bsky.feed.post/${teaserRkey}`,
    canonicalUrl: `https://bsky.app/profile/${did}/post/${teaserRkey}`,
  };
}
