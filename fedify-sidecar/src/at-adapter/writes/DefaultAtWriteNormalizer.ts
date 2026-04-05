/**
 * V6.5 Phase 7: Default AT Write Normalizer
 *
 * Maps XRPC createRecord / putRecord / deleteRecord input into canonical
 * CanonicalMutationEnvelopes.  The normalizer is the only place that knows
 * the AT collection → canonical mutation type mapping.  A per-request
 * clientMutationId is generated here for result correlation.
 *
 * Payload convention:
 *   - All record fields are forwarded as-is so Tier 1 serializers can
 *     extract what they need (text, facets, reply, embed, etc.).
 *   - Private "_at*" fields carry AT coordinates that Tier 1 needs for alias
 *     registration (repo DID, collection NSID, optional rkey hint).
 *   - For deletes, only the AT coordinates are carried — Tier 1 resolves
 *     the canonical object via its alias store.
 */

import { randomUUID } from 'node:crypto';
import type {
  AtCreateRecordInput,
  AtPutRecordInput,
  AtDeleteRecordInput,
  CanonicalMutationEnvelope,
  AtWriteNormalizer,
} from './AtWriteTypes.js';
import type { AtSessionContext } from '../auth/AtSessionTypes.js';
import { XrpcErrors } from '../xrpc/middleware/XrpcErrorMapper.js';

// ---------------------------------------------------------------------------
// Collection → mutationType mappings
// ---------------------------------------------------------------------------

const CREATE_MUTATION_MAP: Partial<Record<string, CanonicalMutationEnvelope['mutationType']>> = {
  'app.bsky.feed.post':     'post_create',
  'site.standard.document': 'post_create',
  'app.bsky.actor.profile': 'profile_upsert',
  'app.bsky.graph.follow':  'follow_create',
  'app.bsky.feed.like':     'like_create',
  'app.bsky.feed.repost':   'repost_create',
};

const DELETE_MUTATION_MAP: Partial<Record<string, CanonicalMutationEnvelope['mutationType']>> = {
  'app.bsky.feed.post':    'post_delete',
  'site.standard.document': 'post_delete',
  'app.bsky.graph.follow': 'follow_delete',
  'app.bsky.feed.like':    'like_delete',
  'app.bsky.feed.repost':  'repost_delete',
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtWriteNormalizer implements AtWriteNormalizer {
  async normalizeCreate(
    input: AtCreateRecordInput,
    auth: AtSessionContext
  ): Promise<CanonicalMutationEnvelope> {
    const mutationType = CREATE_MUTATION_MAP[input.collection];
    if (!mutationType) {
      throw XrpcErrors.unsupportedCollection(input.collection);
    }

    return {
      clientMutationId: randomUUID(),
      canonicalAccountId: auth.canonicalAccountId,
      mutationType,
      payload: {
        ...input.record,
        _atRepo: input.repo,
        _collection: input.collection,
        _operation: "create",
        ...(input.rkey ? { _rkey: input.rkey } : {}),
      },
      submittedAt: new Date().toISOString(),
      source: 'xrpc_client',
    };
  }

  async normalizePut(
    input: AtPutRecordInput,
    auth: AtSessionContext
  ): Promise<CanonicalMutationEnvelope> {
    const mutationType = CREATE_MUTATION_MAP[input.collection];
    if (!mutationType) {
      throw XrpcErrors.unsupportedCollection(input.collection);
    }

    return {
      clientMutationId: randomUUID(),
      canonicalAccountId: auth.canonicalAccountId,
      mutationType,
      payload: {
        ...input.record,
        _atRepo: input.repo,
        _collection: input.collection,
        _operation: "update",
        _rkey: input.rkey,
      },
      submittedAt: new Date().toISOString(),
      source: 'xrpc_client',
    };
  }

  async normalizeDelete(
    input: AtDeleteRecordInput,
    auth: AtSessionContext
  ): Promise<CanonicalMutationEnvelope> {
    const mutationType = DELETE_MUTATION_MAP[input.collection];
    if (!mutationType) {
      throw XrpcErrors.unsupportedCollection(input.collection);
    }

    return {
      clientMutationId: randomUUID(),
      canonicalAccountId: auth.canonicalAccountId,
      mutationType,
      // Only AT coordinates — Tier 1 resolves canonical object via alias store
      payload: {
        _atRepo: input.repo,
        _collection: input.collection,
        _operation: "delete",
        _rkey: input.rkey,
        ...(input.bridgeCanonicalRefId ? { _bridgeCanonicalRefId: input.bridgeCanonicalRefId } : {}),
        ...(input.bridgeMetadata ? { _bridgeMetadata: input.bridgeMetadata } : {}),
      },
      submittedAt: new Date().toISOString(),
      source: 'xrpc_client',
    };
  }
}
