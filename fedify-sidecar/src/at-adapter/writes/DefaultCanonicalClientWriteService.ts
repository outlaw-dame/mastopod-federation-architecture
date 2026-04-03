/**
 * V6.5 Phase 7: Default Canonical Client Write Service
 *
 * Translates CanonicalMutationEnvelope into the correct AtProjectionWorker
 * canonical event call, then publishes the resulting AT URI + CID to
 * AtWriteResultStore for the waiting XRPC route to pick up.
 *
 * Phase 7 design (single-process, synchronous):
 *   applyClientMutation → build canonical event → call projection worker →
 *   read alias back from store → publishResult → return
 *
 * This is intentionally synchronous within the process.  The existing
 * AtProjectionWorker handles the commit builder + persistence service
 * internally, so by the time each onXxx() method returns the alias store
 * contains the committed URI and CID.
 *
 * For multi-replica deployments: replace the direct projectionWorker calls
 * with canonical event publication to RedPanda, and wire the projection
 * consumer to call resultStore.publishResult() after persisting each commit.
 * The AtWriteResultStore would then need to be backed by Redis pub/sub.
 *
 * Supported mutation types (Phase 7 allowlist):
 *   post_create, profile_upsert
 *   follow_create, like_create, repost_create
 *   post_delete, follow_delete, like_delete, repost_delete
 */

import { randomUUID } from 'node:crypto';
import type {
  CanonicalMutationEnvelope,
  CanonicalClientWriteService,
  CanonicalClientWriteResult,
} from './AtWriteTypes.js';
import type { AtWriteResultStore } from './AtWriteResultStore.js';
import type { AtAliasStore } from '../repo/AtAliasStore.js';
import type {
  AtRecordLocator,
  AtRepoBridgeMetadata,
  AtRepoCollection,
} from '../events/AtRepoEvents.js';
import type { AtProjectionWorker } from '../projection/AtProjectionWorker.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type {
  BridgeProfileMediaDraft,
  BridgeProfileMediaStore,
} from '../../protocol-bridge/profile/BridgeProfileMedia.js';
import type {
  CoreFollowCreatedV1,
  CoreFollowDeletedV1,
  CoreLikeCreatedV1,
  CoreLikeDeletedV1,
  CoreRepostCreatedV1,
  CoreRepostDeletedV1,
} from '../events/AtSocialRepoEvents.js';
import type {
  CorePostCreatedV1,
  CorePostUpdatedV1,
  CorePostDeletedV1,
  CoreProfileUpsertedV1,
} from '../projection/AtProjectionWorker.js';

// ---------------------------------------------------------------------------
// Dependencies injection
// ---------------------------------------------------------------------------

export interface DefaultCanonicalClientWriteServiceDeps {
  projectionWorker: AtProjectionWorker;
  aliasStore:       AtAliasStore;
  resultStore:      AtWriteResultStore;
  identityRepo:     IdentityBindingRepository;
  profileMediaStore?: BridgeProfileMediaStore;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultCanonicalClientWriteService implements CanonicalClientWriteService {
  private readonly worker: AtProjectionWorker;
  private readonly aliasStore: AtAliasStore;
  private readonly resultStore: AtWriteResultStore;
  private readonly identityRepo: IdentityBindingRepository;
  private readonly profileMediaStore?: BridgeProfileMediaStore;

  constructor(deps: DefaultCanonicalClientWriteServiceDeps) {
    this.worker      = deps.projectionWorker;
    this.aliasStore  = deps.aliasStore;
    this.resultStore = deps.resultStore;
    this.identityRepo = deps.identityRepo;
    this.profileMediaStore = deps.profileMediaStore;
  }

  async applyClientMutation(
    mutation: CanonicalMutationEnvelope
  ): Promise<CanonicalClientWriteResult> {
    const now = new Date().toISOString();
    let canonicalRefId: string | undefined;

    switch (mutation.mutationType) {
      case 'post_create':
        canonicalRefId = await this._applyPostWrite(mutation, now);
        break;
      case 'profile_upsert':
        canonicalRefId = await this._applyProfileUpsert(mutation, now);
        break;
      case 'follow_create':
        canonicalRefId = await this._applyFollowCreate(mutation, now);
        break;
      case 'like_create':
        canonicalRefId = await this._applyLikeCreate(mutation, now);
        break;
      case 'repost_create':
        canonicalRefId = await this._applyRepostCreate(mutation, now);
        break;
      case 'post_delete':
        await this._applyPostDelete(mutation, now);
        break;
      case 'follow_delete':
        await this._applySocialDelete(mutation, now, 'follow');
        break;
      case 'like_delete':
        await this._applySocialDelete(mutation, now, 'like');
        break;
      case 'repost_delete':
        await this._applySocialDelete(mutation, now, 'repost');
        break;
      default: {
        const _exhaustive: never = mutation.mutationType;
        throw new Error(`Unsupported mutationType: ${_exhaustive}`);
      }
    }

    // Publish projection result (URI+CID) if we have a canonicalRefId.
    // For deletes, there is no URI to publish — the gateway returns {} directly.
    if (canonicalRefId) {
      const alias = await this.aliasStore.getByCanonicalRefId(canonicalRefId);
      if (alias) {
        await this.resultStore.publishResult(mutation.clientMutationId, {
          uri:  alias.atUri,
          cid:  alias.cid  ?? '',
          commit: alias.lastRev ? { cid: alias.cid ?? '', rev: alias.lastRev } : undefined,
        });
      }
    }

    return {
      clientMutationId: mutation.clientMutationId,
      accepted: true,
      ...(canonicalRefId ? { canonicalId: canonicalRefId } : {}),
    };
  }

  // --------------------------------------------------------------------------
  // Create / upsert mutations
  // --------------------------------------------------------------------------

  private async _applyPostWrite(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const p = mutation.payload;
    const operation = getNormalizedWriteOperation(p);
    const collection = _str(p['_collection']);
    const isArticle = collection === 'site.standard.document';
    const bridge = asBridgeMetadata(p['_bridgeMetadata']);
    const atRecord = extractAtRecordLocator(p);
    const canonicalRefId = operation === 'update'
      ? await this._resolveCanonicalRefIdForPostUpdate(mutation)
      : _str(mutation.payload['_bridgeCanonicalRefId']) ?? randomUUID();

    const canonicalPost = {
      id: canonicalRefId,
      authorId: mutation.canonicalAccountId,
      kind: isArticle ? 'article' as const : 'note' as const,
      title: _str(p['title']),
      summaryPlaintext: _str(p['summary']),
      bodyPlaintext: _str(p['text']) ?? '',
      canonicalUrl: _str(p['url']),
      visibility: 'public' as const,
      publishedAt: _str(p['publishedAt']) ?? _str(p['createdAt']) ?? now,
    };

    if (operation === 'update') {
      const event: CorePostUpdatedV1 = {
        canonicalPost,
        author: { id: mutation.canonicalAccountId },
        ...(atRecord ? { atRecord } : {}),
        ...(bridge ? { bridge } : {}),
        emittedAt: now,
      };
      await this.worker.onPostUpdated(event);
      return canonicalRefId;
    }

    const event: CorePostCreatedV1 = {
      canonicalPost,
      author: { id: mutation.canonicalAccountId },
      ...(atRecord ? { atRecord } : {}),
      ...(bridge ? { bridge } : {}),
      emittedAt: now,
    };

    await this.worker.onPostCreated(event);
    return canonicalRefId;
  }

  private async _applyProfileUpsert(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    // Profile canonical ref ID = canonicalAccountId (singleton per account)
    const canonicalRefId = mutation.canonicalAccountId;
    const p = mutation.payload;
    const bridge = asBridgeMetadata(p['_bridgeMetadata']);
    const ownerDid = await this._resolveManagedDid(mutation);
    const profileMedia = parseBridgeProfileMediaPayload(p['_bridgeProfileMedia']);

    if (ownerDid && this.profileMediaStore) {
      if (profileMedia.avatar) {
        await this.profileMediaStore.put({
          ...profileMedia.avatar,
          ownerDid,
          createdAt: now,
        });
      }
      if (profileMedia.banner) {
        await this.profileMediaStore.put({
          ...profileMedia.banner,
          ownerDid,
          createdAt: now,
        });
      }
    }

    const event: CoreProfileUpsertedV1 = {
      profile: {
        id:                  canonicalRefId,
        displayName:         _str(p['displayName']),
        summaryPlaintext:    _str(p['description']),
        avatarBlobRef:       asBlobRef(p['avatar']),
        bannerBlobRef:       asBlobRef(p['banner']),
        avatarMediaId:       profileMedia.avatar?.mediaId,
        bannerMediaId:       profileMedia.banner?.mediaId,
      },
      identity: { id: mutation.canonicalAccountId },
      ...(bridge ? { bridge } : {}),
      emittedAt: now,
    };

    await this.worker.onProfileUpserted(event);
    return canonicalRefId;
  }

  private async _applyFollowCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = _str(mutation.payload['_bridgeCanonicalRefId']) ?? randomUUID();
    const subjectDid = _str(mutation.payload['subject']);
    const bridge = asBridgeMetadata(mutation.payload['_bridgeMetadata']);
    const atRecord = extractAtRecordLocator(mutation.payload);
    if (!subjectDid) {
      throw new Error('follow_create: subject (DID) is required in payload');
    }

    // Resolve followed identity — may be local or remote
    const followedBinding = await this.identityRepo.getByAtprotoDid(subjectDid);
    const followedIdentity = followedBinding
      ? { id: followedBinding.canonicalAccountId }
      : { id: subjectDid, atprotoDid: subjectDid } as any;

    const event: CoreFollowCreatedV1 = {
      follow: {
        id:         canonicalRefId,
        followerId: mutation.canonicalAccountId,
        followedId: followedBinding?.canonicalAccountId ?? subjectDid,
        createdAt:  now,
      },
      follower: { id: mutation.canonicalAccountId },
      followed: followedIdentity,
      ...(atRecord ? { atRecord } : {}),
      ...(bridge ? { bridge } : {}),
      emittedAt: now,
    };

    await this.worker.onFollowCreated(event);
    return canonicalRefId;
  }

  private async _applyLikeCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = _str(mutation.payload['_bridgeCanonicalRefId']) ?? randomUUID();
    const subject = mutation.payload['subject'] as { uri?: string; cid?: string } | undefined;
    const bridge = asBridgeMetadata(mutation.payload['_bridgeMetadata']);
    const atRecord = extractAtRecordLocator(mutation.payload);
    if (!subject?.uri) {
      throw new Error('like_create: subject.uri is required in payload');
    }

    const targetAlias = await this._resolveAliasByUri(subject.uri);
    const targetPost = targetAlias
      ? { id: targetAlias.canonicalRefId, authorId: '', bodyPlaintext: '', visibility: 'public' as const, publishedAt: now }
      : { id: subject.uri, authorId: '', bodyPlaintext: '', visibility: 'public' as const, publishedAt: now };

    const event: CoreLikeCreatedV1 = {
      like: {
        id:      canonicalRefId,
        actorId: mutation.canonicalAccountId,
        postId:  targetAlias?.canonicalRefId ?? subject.uri,
        createdAt: now,
      },
      actor:      { id: mutation.canonicalAccountId },
      targetPost,
      ...(atRecord ? { atRecord } : {}),
      ...(bridge ? { bridge } : {}),
      emittedAt:  now,
    };

    await this.worker.onLikeCreated(event);
    return canonicalRefId;
  }

  private async _applyRepostCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = _str(mutation.payload['_bridgeCanonicalRefId']) ?? randomUUID();
    const subject = mutation.payload['subject'] as { uri?: string; cid?: string } | undefined;
    const bridge = asBridgeMetadata(mutation.payload['_bridgeMetadata']);
    const atRecord = extractAtRecordLocator(mutation.payload);
    if (!subject?.uri) {
      throw new Error('repost_create: subject.uri is required in payload');
    }

    const targetAlias = await this._resolveAliasByUri(subject.uri);
    const targetPost = targetAlias
      ? { id: targetAlias.canonicalRefId, authorId: '', bodyPlaintext: '', visibility: 'public' as const, publishedAt: now }
      : { id: subject.uri, authorId: '', bodyPlaintext: '', visibility: 'public' as const, publishedAt: now };

    const event: CoreRepostCreatedV1 = {
      repost: {
        id:      canonicalRefId,
        actorId: mutation.canonicalAccountId,
        postId:  targetAlias?.canonicalRefId ?? subject.uri,
        createdAt: now,
      },
      actor:      { id: mutation.canonicalAccountId },
      targetPost,
      ...(atRecord ? { atRecord } : {}),
      ...(bridge ? { bridge } : {}),
      emittedAt:  now,
    };

    await this.worker.onRepostCreated(event);
    return canonicalRefId;
  }

  // --------------------------------------------------------------------------
  // Delete mutations
  // --------------------------------------------------------------------------

  private async _applyPostDelete(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<void> {
    const canonicalRefId = await this._resolveDeleteCanonicalRefId(mutation);
    if (!canonicalRefId) return;
    const bridge = asBridgeMetadata(mutation.payload['_bridgeMetadata']);
    const atRecord = extractAtRecordLocator(mutation.payload);

    const event: CorePostDeletedV1 = {
      canonicalPostId:   canonicalRefId,
      canonicalAuthorId: mutation.canonicalAccountId,
      ...(atRecord ? { atRecord } : {}),
      ...(bridge ? { bridge } : {}),
      deletedAt:         now,
      emittedAt:         now,
    };
    await this.worker.onPostDeleted(event);
  }

  private async _applySocialDelete(
    mutation: CanonicalMutationEnvelope,
    now: string,
    kind: 'follow' | 'like' | 'repost'
  ): Promise<void> {
    const canonicalRefId = await this._resolveDeleteCanonicalRefId(mutation);
    const bridge = asBridgeMetadata(mutation.payload['_bridgeMetadata']);
    const atRecord = extractAtRecordLocator(mutation.payload);
    if (!canonicalRefId) return;

    switch (kind) {
      case 'follow': {
        const event: CoreFollowDeletedV1 = {
          canonicalFollowId:    canonicalRefId,
          followerCanonicalId:  mutation.canonicalAccountId,
          followedCanonicalId:  '',
          ...(atRecord ? { atRecord } : {}),
          ...(bridge ? { bridge } : {}),
          deletedAt:            now,
          emittedAt:            now,
        };
        await this.worker.onFollowDeleted(event);
        break;
      }
      case 'like': {
        const event: CoreLikeDeletedV1 = {
          canonicalLikeId:   canonicalRefId,
          canonicalActorId:  mutation.canonicalAccountId,
          canonicalPostId:   '',  // not needed by projection worker for delete
          ...(atRecord ? { atRecord } : {}),
          ...(bridge ? { bridge } : {}),
          deletedAt:         now,
          emittedAt:         now,
        };
        await this.worker.onLikeDeleted(event);
        break;
      }
      case 'repost': {
        const event: CoreRepostDeletedV1 = {
          canonicalRepostId:  canonicalRefId,
          canonicalActorId:   mutation.canonicalAccountId,
          canonicalPostId:    '',
          ...(atRecord ? { atRecord } : {}),
          ...(bridge ? { bridge } : {}),
          deletedAt:          now,
          emittedAt:          now,
        };
        await this.worker.onRepostDeleted(event);
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve alias from AT URI by parsing and scanning the alias store.
   * e.g. at://did:plc:xxx/app.bsky.feed.post/3jyxxxxxx
   */
  private async _resolveAliasByUri(atUri: string) {
    // at://<did>/<collection>/<rkey>
    const match = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    const did = match[1]!;
    const collection = match[2]!;
    const rkey = match[3]!;
    const aliases = await this.aliasStore.listByDid(did);
    return aliases.find((a) => a.collection === collection && a.rkey === rkey && !a.deletedAt) ?? null;
  }

  /**
   * Resolve the alias record for a delete mutation using _atRepo + _collection + _rkey.
   */
  private async _resolveDeleteAlias(mutation: CanonicalMutationEnvelope) {
    const p = mutation.payload;
    const collection = _str(p['_collection']);
    const rkey       = _str(p['_rkey']);

    // Resolve DID from repo identifier via identity binding
    const atRepo = _str(p['_atRepo']);
    if (!collection || !rkey || !atRepo) return null;

    // Try to get DID from identity binding (handles both DID and handle inputs)
    let repoDid: string | null = null;
    if (atRepo.startsWith('did:')) {
      repoDid = atRepo;
    } else {
      const b = await this.identityRepo.getByAtprotoHandle(atRepo);
      repoDid = b?.atprotoDid ?? null;
    }
    if (!repoDid) return null;

    const aliases = await this.aliasStore.listByDid(repoDid);
    return aliases.find((a) => a.collection === collection && a.rkey === rkey && !a.deletedAt) ?? null;
  }

  private async _resolveDeleteCanonicalRefId(
    mutation: CanonicalMutationEnvelope,
  ): Promise<string | null> {
    const explicit = _str(mutation.payload['_bridgeCanonicalRefId']);
    if (explicit) {
      return explicit;
    }

    const alias = await this._resolveDeleteAlias(mutation);
    return alias?.canonicalRefId ?? null;
  }

  private async _resolveCanonicalRefIdForPostUpdate(
    mutation: CanonicalMutationEnvelope,
  ): Promise<string> {
    const explicit = _str(mutation.payload['_bridgeCanonicalRefId']);
    if (explicit) {
      return explicit;
    }

    const collection = _str(mutation.payload['_collection']);
    const rkey = _str(mutation.payload['_rkey']);
    if (!collection || !rkey) {
      throw new Error('post_update: _collection and _rkey are required to resolve the canonical target');
    }

    const repoDid = await this._resolveManagedDid(mutation);
    if (!repoDid) {
      throw new Error('post_update: unable to resolve the local ATProto DID for the target account');
    }

    const aliases = await this.aliasStore.listByDid(repoDid);
    const alias = aliases.find(
      (candidate) =>
        candidate.collection === collection &&
        candidate.rkey === rkey &&
        !candidate.deletedAt,
    );

    if (!alias) {
      throw new Error(`post_update: no active alias exists for at://${repoDid}/${collection}/${rkey}`);
    }

    return alias.canonicalRefId;
  }

  private async _resolveManagedDid(mutation: CanonicalMutationEnvelope): Promise<string | null> {
    const repo = _str(mutation.payload['_atRepo']);
    if (repo?.startsWith('did:')) {
      return repo;
    }

    const binding = await this.identityRepo.getByCanonicalAccountId(mutation.canonicalAccountId);
    return binding?.atprotoDid ?? null;
  }
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function _str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asBridgeMetadata(value: unknown): AtRepoBridgeMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as {
    canonicalIntentId?: unknown;
    sourceProtocol?: unknown;
    provenance?: {
      originProtocol?: unknown;
      originEventId?: unknown;
      originAccountId?: unknown;
      mirroredFromCanonicalIntentId?: unknown;
      projectionMode?: unknown;
    };
  };

  if (
    typeof candidate.canonicalIntentId !== 'string' ||
    (candidate.sourceProtocol !== 'activitypub' && candidate.sourceProtocol !== 'atproto') ||
    !candidate.provenance ||
    (candidate.provenance.originProtocol !== 'activitypub' && candidate.provenance.originProtocol !== 'atproto') ||
    typeof candidate.provenance.originEventId !== 'string' ||
    (candidate.provenance.projectionMode !== 'native' && candidate.provenance.projectionMode !== 'mirrored')
  ) {
    return undefined;
  }

  return {
    canonicalIntentId: candidate.canonicalIntentId,
    sourceProtocol: candidate.sourceProtocol,
    provenance: {
      originProtocol: candidate.provenance.originProtocol,
      originEventId: candidate.provenance.originEventId,
      originAccountId:
        typeof candidate.provenance.originAccountId === 'string'
          ? candidate.provenance.originAccountId
          : null,
      mirroredFromCanonicalIntentId:
        typeof candidate.provenance.mirroredFromCanonicalIntentId === 'string'
          ? candidate.provenance.mirroredFromCanonicalIntentId
          : null,
      projectionMode: candidate.provenance.projectionMode,
    },
  };
}

function getNormalizedWriteOperation(
  payload: Record<string, unknown>,
): 'create' | 'update' {
  return payload['_operation'] === 'update' ? 'update' : 'create';
}

function parseBridgeProfileMediaPayload(
  value: unknown,
): { avatar?: BridgeProfileMediaDraft; banner?: BridgeProfileMediaDraft } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const container = value as Record<string, unknown>;
  const avatar = asProfileMediaDraft(container['avatar'], 'avatar');
  const banner = asProfileMediaDraft(container['banner'], 'banner');
  return {
    ...(avatar ? { avatar } : {}),
    ...(banner ? { banner } : {}),
  };
}

function extractAtRecordLocator(payload: Record<string, unknown>): AtRecordLocator | undefined {
  const collection = _str(payload['_collection']);
  const rkey = _str(payload['_rkey']);
  if (!collection || !rkey || !isAtRepoCollection(collection)) {
    return undefined;
  }
  return { collection, rkey };
}

function isAtRepoCollection(value: string): value is AtRepoCollection {
  return value === 'app.bsky.actor.profile'
    || value === 'app.bsky.feed.post'
    || value === 'site.standard.document'
    || value === 'app.bsky.graph.follow'
    || value === 'app.bsky.feed.like'
    || value === 'app.bsky.feed.repost';
}

function asProfileMediaDraft(
  value: unknown,
  expectedRole: 'avatar' | 'banner',
): BridgeProfileMediaDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as {
    mediaId?: unknown;
    role?: unknown;
    sourceUrl?: unknown;
    mimeType?: unknown;
    alt?: unknown;
    width?: unknown;
    height?: unknown;
  };

  if (
    typeof candidate.mediaId !== 'string' ||
    candidate.role !== expectedRole ||
    typeof candidate.sourceUrl !== 'string' ||
    typeof candidate.mimeType !== 'string'
  ) {
    return undefined;
  }

  return {
    mediaId: candidate.mediaId,
    role: expectedRole,
    sourceUrl: candidate.sourceUrl,
    mimeType: candidate.mimeType,
    alt: typeof candidate.alt === 'string' ? candidate.alt : null,
    width: typeof candidate.width === 'number' && Number.isFinite(candidate.width) ? candidate.width : null,
    height: typeof candidate.height === 'number' && Number.isFinite(candidate.height) ? candidate.height : null,
  };
}

function asBlobRef(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as {
    $type?: unknown;
    ref?: {
      $link?: unknown;
    };
    mimeType?: unknown;
    size?: unknown;
  };
  if (!candidate.ref || typeof candidate.ref !== 'object' || Array.isArray(candidate.ref)) {
    return undefined;
  }
  if (typeof candidate.ref.$link !== 'string') {
    return undefined;
  }
  if (candidate.$type != null && candidate.$type !== 'blob') {
    return undefined;
  }

  const blobRef: Record<string, unknown> = {
    ref: {
      $link: candidate.ref.$link,
    },
  };
  if (candidate.$type === 'blob') {
    blobRef['$type'] = 'blob';
  }
  if (typeof candidate.mimeType === 'string') {
    blobRef['mimeType'] = candidate.mimeType;
  }
  if (typeof candidate.size === 'number' && Number.isFinite(candidate.size)) {
    blobRef['size'] = candidate.size;
  }
  return blobRef;
}
