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
import type { AtProjectionWorker } from '../projection/AtProjectionWorker.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultCanonicalClientWriteService implements CanonicalClientWriteService {
  private readonly worker: AtProjectionWorker;
  private readonly aliasStore: AtAliasStore;
  private readonly resultStore: AtWriteResultStore;
  private readonly identityRepo: IdentityBindingRepository;

  constructor(deps: DefaultCanonicalClientWriteServiceDeps) {
    this.worker      = deps.projectionWorker;
    this.aliasStore  = deps.aliasStore;
    this.resultStore = deps.resultStore;
    this.identityRepo = deps.identityRepo;
  }

  async applyClientMutation(
    mutation: CanonicalMutationEnvelope
  ): Promise<CanonicalClientWriteResult> {
    const now = new Date().toISOString();
    let canonicalRefId: string | undefined;

    switch (mutation.mutationType) {
      case 'post_create':
        canonicalRefId = await this._applyPostCreate(mutation, now);
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

  private async _applyPostCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = randomUUID();
    const p = mutation.payload;

    const event: CorePostCreatedV1 = {
      canonicalPost: {
        id:             canonicalRefId,
        authorId:       mutation.canonicalAccountId,
        bodyPlaintext:  _str(p.text) ?? '',
        visibility:     'public',
        publishedAt:    _str(p.createdAt) ?? now,
      },
      author: { id: mutation.canonicalAccountId },
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

    const event: CoreProfileUpsertedV1 = {
      profile: {
        id:                  canonicalRefId,
        displayName:         _str(p.displayName),
        summaryPlaintext:    _str(p.description),
      },
      identity: { id: mutation.canonicalAccountId },
      emittedAt: now,
    };

    await this.worker.onProfileUpserted(event);
    return canonicalRefId;
  }

  private async _applyFollowCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = randomUUID();
    const subjectDid = _str(mutation.payload.subject);
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
      emittedAt: now,
    };

    await this.worker.onFollowCreated(event);
    return canonicalRefId;
  }

  private async _applyLikeCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = randomUUID();
    const subject = mutation.payload.subject as { uri?: string; cid?: string } | undefined;
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
      emittedAt:  now,
    };

    await this.worker.onLikeCreated(event);
    return canonicalRefId;
  }

  private async _applyRepostCreate(
    mutation: CanonicalMutationEnvelope,
    now: string
  ): Promise<string> {
    const canonicalRefId = randomUUID();
    const subject = mutation.payload.subject as { uri?: string; cid?: string } | undefined;
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
    const alias = await this._resolveDeleteAlias(mutation);
    if (!alias) return; // Policy gate should have caught this; silent skip

    const event: CorePostDeletedV1 = {
      canonicalPostId:   alias.canonicalRefId,
      canonicalAuthorId: mutation.canonicalAccountId,
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
    const alias = await this._resolveDeleteAlias(mutation);
    if (!alias) return;

    switch (kind) {
      case 'follow': {
        const event: CoreFollowDeletedV1 = {
          canonicalFollowId:    alias.canonicalRefId,
          followerCanonicalId:  mutation.canonicalAccountId,
          followedCanonicalId:  alias.subjectDid ?? '',
          deletedAt:            now,
          emittedAt:            now,
        };
        await this.worker.onFollowDeleted(event);
        break;
      }
      case 'like': {
        const event: CoreLikeDeletedV1 = {
          canonicalLikeId:   alias.canonicalRefId,
          canonicalActorId:  mutation.canonicalAccountId,
          canonicalPostId:   '',  // not needed by projection worker for delete
          deletedAt:         now,
          emittedAt:         now,
        };
        await this.worker.onLikeDeleted(event);
        break;
      }
      case 'repost': {
        const event: CoreRepostDeletedV1 = {
          canonicalRepostId:  alias.canonicalRefId,
          canonicalActorId:   mutation.canonicalAccountId,
          canonicalPostId:    '',
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
    const [, did, collection, rkey] = match;
    const aliases = await this.aliasStore.listByDid(did);
    return aliases.find((a) => a.collection === collection && a.rkey === rkey && !a.deletedAt) ?? null;
  }

  /**
   * Resolve the alias record for a delete mutation using _atRepo + _collection + _rkey.
   */
  private async _resolveDeleteAlias(mutation: CanonicalMutationEnvelope) {
    const p = mutation.payload;
    const collection = _str(p._collection);
    const rkey       = _str(p._rkey);

    // Resolve DID from repo identifier via identity binding
    const atRepo = _str(p._atRepo);
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
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function _str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
