/**
 * V6.5 Phase 5.5: External ATProto Firehose Intake — Event Schemas
 *
 * Locked topic schemas for the inbound AT firehose pipeline:
 *   at.firehose.raw.v1   — raw untrusted envelopes from external sources
 *   at.ingress.v1        — trusted, verified, normalised events
 *   at.verify-failed.v1  — structured failure records for observability
 *
 * Design principles:
 *   - Raw envelopes preserve original CBOR bytes for replay/redecode.
 *   - Trusted events are never emitted unless all verification passes.
 *   - Failure events are structured and typed to enable downstream alerting.
 *
 * Ref: https://atproto.com/specs/event-stream
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * The five frame types defined by the ATProto sync spec.
 * #info is a stream-level control frame; the rest carry repo state.
 */
export type AtFirehoseEventType =
  | '#commit'
  | '#identity'
  | '#account'
  | '#sync'
  | '#info';

// ---------------------------------------------------------------------------
// at.firehose.raw.v1
// ---------------------------------------------------------------------------

/**
 * Raw, untrusted envelope published to at.firehose.raw.v1 immediately after
 * the WebSocket frame is received and before any verification is performed.
 *
 * The rawCborBase64 field preserves the original frame bytes verbatim so that
 * the verifier can re-decode with updated logic without re-fetching from the
 * upstream firehose.
 */
export interface AtFirehoseRawEnvelope {
  /** ATProto firehose sequence number — the reliable cursor field. */
  seq: number;

  /**
   * Upstream source URI, e.g. "wss://relay.bsky.network".
   * Required for checkpointing, observability, and deduplication.
   */
  source: string;

  /** ISO-8601 UTC timestamp of local receipt. */
  receivedAt: string;

  /** Classified event type extracted from the CBOR header. */
  eventType: AtFirehoseEventType;

  /**
   * DID extracted cheaply from the frame header where available.
   * Null for control frames such as #info.
   */
  did?: string | null;

  /** Original CBOR frame bytes encoded as base64 (standard, no padding stripped). */
  rawCborBase64: string;
}

// ---------------------------------------------------------------------------
// at.ingress.v1
// ---------------------------------------------------------------------------

/**
 * Trusted, normalised inbound AT event published to at.ingress.v1 only after
 * all verification steps pass.  Failed verification never lands here.
 *
 * The shape follows the ATProto sync spec event types:
 *   #commit  — per-record repo mutations with self-certifying signatures
 *   #identity — DID/handle change hints (re-resolved before publishing)
 *   #account  — hosting-status assertions from the emitting service
 */
export interface AtIngressEvent {
  /** ATProto firehose sequence number. */
  seq: number;

  /** DID of the account this event concerns. */
  did: string;

  /** Verified event type (never #sync or #info — those are handled separately). */
  eventType: '#commit' | '#identity' | '#account';

  /** ISO-8601 UTC timestamp of local verification completion. */
  verifiedAt: string;

  /** Upstream source URI. */
  source: string;

  /**
   * Present when eventType === '#commit'.
   * Contains the verified, normalised record-level operation.
   */
  commit?: {
    /** Repository revision (monotonic TID string). */
    rev: string;

    /** Record-level operation type. */
    operation: 'create' | 'update' | 'delete';

    /** Lexicon collection NSID, e.g. "app.bsky.feed.post". */
    collection: string;

    /** Record key. */
    rkey: string;

    /** Content-addressed CID of the record (null for deletes). */
    cid: string | null;

    /**
     * Decoded record value (null for deletes or when record is not included
     * in the CAR slice).
     */
    record?: Record<string, unknown> | null;

    /**
     * Cryptographic signature validity.  Always true here because events with
     * invalid signatures are routed to at.verify-failed.v1 instead.
     */
    signatureValid: true;
  };

  /**
   * Present when eventType === '#identity'.
   * Contains the freshly re-resolved identity data.
   */
  identity?: {
    /** Current handle as resolved from the DID document (may be undefined). */
    handle?: string;

    /** Full DID document as returned by the PLC directory. */
    didDocument: Record<string, unknown>;
  };

  /**
   * Present when eventType === '#account'.
   * Contains the hosting-status assertion from the emitting service.
   */
  account?: {
    /** Whether the account is currently active at the emitting service. */
    active: boolean;

    /**
     * Reason for inactivity when active === false.
     * Semantics are defined by the ATProto sync spec.
     */
    status?: 'takendown' | 'suspended' | 'deleted' | 'deactivated';
  };
}

// ---------------------------------------------------------------------------
// at.verify-failed.v1
// ---------------------------------------------------------------------------

/**
 * Structured failure record published to at.verify-failed.v1 when any
 * verification, decoding, or reconciliation step fails.
 *
 * This topic makes failures observable and replayable without polluting the
 * trusted at.ingress.v1 stream.
 */
export interface AtVerifyFailedEvent {
  /** ATProto firehose sequence number of the failing frame. */
  seq: number;

  /** DID extracted from the frame, if available. */
  did?: string | null;

  /** Upstream source URI. */
  source: string;

  /** Original event type of the failing frame. */
  eventType: AtFirehoseEventType;

  /** ISO-8601 UTC timestamp of failure detection. */
  failedAt: string;

  /**
   * Structured failure reason.  Each value maps to a specific verification
   * step to enable targeted alerting and replay filtering.
   */
  reason:
    | 'decode_failed'
    | 'unsupported_event'
    | 'signature_invalid'
    | 'repo_state_invalid'
    | 'did_resolution_failed'
    | 'handle_validation_failed'
    | 'account_reconciliation_failed'
    | 'sync_rebuild_failed'
    | 'dedupe_rejected';

  /** Optional structured details for debugging. */
  details?: Record<string, unknown>;
}
