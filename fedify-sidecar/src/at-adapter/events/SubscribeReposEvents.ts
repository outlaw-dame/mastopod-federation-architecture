/**
 * V6.5 Phase 4: subscribeRepos Internal Event Schema
 *
 * Optional internal topic (at.firehose.event.v1) that carries already-encoded
 * firehose envelopes.  Useful if replay is sourced from a single pre-encoded
 * RedPanda topic rather than re-encoding on each replay request.
 *
 * Storage note (V6 architecture rule):
 *   This topic is append-only and lives in RedPanda, not Redis.
 *   Redis holds only short-lived subscriber state (cursor position per
 *   connection), never authoritative replay history.
 */

export interface AtFirehoseEventV1 {
  /** Global monotonic sequence number assigned by this adapter host. */
  seq: number;
  /** Event type discriminator. */
  eventType: '#commit' | '#identity' | '#account';
  /** DID of the account this event relates to. */
  did: string;
  /** ISO 8601 emission timestamp. */
  emittedAt: string;
  /**
   * Base64-encoded CBOR wire payload (the full [header, body] envelope).
   * Consumers can decode this directly and forward to WebSocket clients
   * without re-encoding.
   */
  encodedBase64: string;
}
