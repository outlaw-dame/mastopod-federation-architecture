/**
 * V6.5 Phase 7: ATProto Write Gateway Types
 *
 * Defines the full write-path contract for XRPC mutation endpoints.
 *
 * Design rule: every XRPC write procedure (createRecord, putRecord,
 * deleteRecord) MUST flow through this gateway.  The gateway normalizes
 * the AT-native request into a CanonicalMutationEnvelope, submits it to
 * CanonicalClientWriteService (Tier 1), then correlates the resulting
 * projection commit back to an AT URI + CID for the XRPC response.
 *
 * No XRPC write endpoint is allowed to mutate AT repo state directly.
 */

import type { AtSessionContext } from '../auth/AtSessionTypes.js';

// ---------------------------------------------------------------------------
// Supported collections (Phase 7 allowlist — mirrors Phase 6 ingress policy)
// ---------------------------------------------------------------------------

export type SupportedAtCollection =
  | 'app.bsky.feed.post'
  | 'app.bsky.actor.profile'
  | 'app.bsky.graph.follow'
  | 'app.bsky.feed.like'
  | 'app.bsky.feed.repost';

export const SUPPORTED_COLLECTIONS: ReadonlySet<string> = new Set([
  'app.bsky.feed.post',
  'app.bsky.actor.profile',
  'app.bsky.graph.follow',
  'app.bsky.feed.like',
  'app.bsky.feed.repost',
]);

// ---------------------------------------------------------------------------
// XRPC input shapes (Lexicon-matching request bodies)
// ---------------------------------------------------------------------------

export interface AtCreateRecordInput {
  /** DID or handle of the repo to write to */
  repo: string;
  /** Collection NSID (must be in SUPPORTED_COLLECTIONS) */
  collection: SupportedAtCollection | string;
  /** Optional client-supplied rkey; server generates one if absent */
  rkey?: string;
  /** Whether to validate the record against the Lexicon schema (default true) */
  validate?: boolean;
  /** The record value — shape depends on collection */
  record: Record<string, unknown>;
  /**
   * Client-supplied idempotency key.
   * If provided and a prior write with the same key succeeded, the previous
   * result is returned without creating a duplicate.
   */
  swapCommit?: string;
}

export interface AtPutRecordInput {
  /** DID or handle of the repo */
  repo: string;
  /** Collection NSID */
  collection: SupportedAtCollection | string;
  /** Record key — required for PUT (must match an existing record for updates) */
  rkey: string;
  /** Whether to validate the record */
  validate?: boolean;
  /** The new record value */
  record: Record<string, unknown>;
  /** CID of the record being replaced (for optimistic concurrency) */
  swapRecord?: string;
  /** CID of the current repo commit (for optimistic concurrency) */
  swapCommit?: string;
}

export interface AtDeleteRecordInput {
  /** DID or handle of the repo */
  repo: string;
  /** Collection NSID */
  collection: string;
  /** Record key to delete */
  rkey: string;
  /** CID of the record being deleted (optimistic concurrency) */
  swapRecord?: string;
  /** CID of the current repo commit (optimistic concurrency) */
  swapCommit?: string;
}

// ---------------------------------------------------------------------------
// XRPC response shapes (Lexicon-matching)
// ---------------------------------------------------------------------------

export interface AtWriteResult {
  /** AT URI of the created/updated record: at://<did>/<collection>/<rkey> */
  uri: string;
  /** CID of the record node in the MST commit */
  cid: string;
  /** The resulting commit object (CID + rev), if available */
  commit?: {
    cid: string;
    rev: string;
  };
  /** The record value as stored */
  validationStatus?: 'valid' | 'unknown';
}

export interface AtDeleteResult {
  /** The resulting commit object (CID + rev), if available */
  commit?: {
    cid: string;
    rev: string;
  };
}

// ---------------------------------------------------------------------------
// Canonical mutation envelope (AT → Tier 1 normalized form)
// ---------------------------------------------------------------------------

/**
 * The normalized canonical write intent produced by AtWriteNormalizer.
 * This is what CanonicalClientWriteService accepts — it has no AT-specific
 * semantics; it only describes a canonical social action.
 */
export interface CanonicalMutationEnvelope {
  /**
   * Client-generated idempotency key.
   * Used to correlate the projection result back to the XRPC response via
   * AtWriteResultStore.
   */
  clientMutationId: string;

  /** Canonical account performing the write */
  canonicalAccountId: string;

  /** Type of canonical mutation */
  mutationType:
    | 'post_create'
    | 'post_delete'
    | 'profile_upsert'
    | 'follow_create'
    | 'follow_delete'
    | 'like_create'
    | 'like_delete'
    | 'repost_create'
    | 'repost_delete';

  /** Mutation payload — shape depends on mutationType */
  payload: Record<string, unknown>;

  /** ISO 8601 timestamp when the mutation was submitted */
  submittedAt: string;

  /** Source of the write for audit purposes */
  source: 'xrpc_client';
}

// ---------------------------------------------------------------------------
// Write gateway interface
// ---------------------------------------------------------------------------

export interface AtWriteGateway {
  /**
   * Process a com.atproto.repo.createRecord request.
   * Validates, normalizes, submits to Tier 1, and awaits projection result.
   */
  createRecord(
    input: AtCreateRecordInput,
    auth: AtSessionContext
  ): Promise<AtWriteResult>;

  /**
   * Process a com.atproto.repo.putRecord request.
   * For singleton records (profiles) this is always an upsert.
   */
  putRecord(
    input: AtPutRecordInput,
    auth: AtSessionContext
  ): Promise<AtWriteResult>;

  /**
   * Process a com.atproto.repo.deleteRecord request.
   * Resolves AT repo coordinates to canonical object, then deletes.
   */
  deleteRecord(
    input: AtDeleteRecordInput,
    auth: AtSessionContext
  ): Promise<AtDeleteResult>;
}

// ---------------------------------------------------------------------------
// Write normalizer interface
// ---------------------------------------------------------------------------

export interface AtWriteNormalizer {
  normalizeCreate(
    input: AtCreateRecordInput,
    auth: AtSessionContext
  ): Promise<CanonicalMutationEnvelope>;

  normalizePut(
    input: AtPutRecordInput,
    auth: AtSessionContext
  ): Promise<CanonicalMutationEnvelope>;

  normalizeDelete(
    input: AtDeleteRecordInput,
    auth: AtSessionContext
  ): Promise<CanonicalMutationEnvelope>;
}

// ---------------------------------------------------------------------------
// Write policy gate interface
// ---------------------------------------------------------------------------

export interface AtWritePolicyDecision {
  decision: 'ACCEPT' | 'REJECT';
  /** Machine-readable reason code when decision=REJECT */
  reasonCode?: 'UnsupportedCollection' | 'Forbidden' | 'WriteNotAllowed' | string;
  /** Human-readable detail */
  message?: string;
}

export interface AtWritePolicyGate {
  /**
   * Evaluate a canonical mutation envelope against write policy.
   * Called AFTER normalization, BEFORE canonical write submission.
   *
   * Enforces:
   * - Caller owns the target canonical account
   * - Collection is in the supported allowlist
   * - Write semantics are permitted for this collection
   * - Any business-rule constraints
   */
  evaluate(
    mutation: CanonicalMutationEnvelope,
    auth: AtSessionContext
  ): Promise<AtWritePolicyDecision>;
}

// ---------------------------------------------------------------------------
// Canonical client write service interface
// ---------------------------------------------------------------------------

export interface CanonicalClientWriteResult {
  /** Echoed back for correlation */
  clientMutationId: string;
  /** Whether the mutation was accepted by Tier 1 */
  accepted: boolean;
  /** Tier 1 canonical object ID assigned to this mutation */
  canonicalId?: string;
}

export interface CanonicalClientWriteService {
  /**
   * Apply a canonical mutation envelope to Tier 1.
   * Emits canonical events that drive AT repo projection.
   * Idempotent with respect to clientMutationId.
   */
  applyClientMutation(
    mutation: CanonicalMutationEnvelope
  ): Promise<CanonicalClientWriteResult>;
}

// ---------------------------------------------------------------------------
// Write alias resolver (AT repo coords → canonical object)
// ---------------------------------------------------------------------------

export interface AtWriteAliasResolver {
  /**
   * Resolve an AT record reference (DID + collection + rkey) to the
   * canonical object it maps to.
   * Returns null when no alias exists (record not projected from this instance).
   */
  resolveCanonicalFromAtRecord(
    repoDid: string,
    collection: string,
    rkey: string
  ): Promise<{
    canonicalRefId: string;
    canonicalType: 'profile' | 'post' | 'follow' | 'like' | 'repost';
  } | null>;
}
