/**
 * V6.5 Phase 5.5: AT Firehose Decoder
 *
 * Decodes raw CBOR frames from the ATProto firehose WebSocket stream.
 *
 * The ATProto sync spec defines the wire format as CBOR-encoded messages
 * delivered over WebSocket.  Each frame consists of two CBOR-encoded values
 * concatenated: a header map (containing "op", "t", and optionally "error")
 * followed by a body map.
 *
 * Security notes:
 *   - All decoded values are validated for expected types before use.
 *   - Numeric fields are clamped/validated to prevent integer overflow.
 *   - DID values are validated against the did: prefix before propagation.
 *   - Unknown event types are tolerated (classified as '#info') rather than
 *     throwing, to preserve stream robustness.
 *   - The full decode path is isolated from the header-only path so that
 *     expensive full decodes are only performed by the verifier.
 *
 * Ref: https://atproto.com/specs/event-stream
 */

import { decodeFirst as decodeCborFirst } from 'cborg';
import { CID } from 'multiformats/cid';
import { AtFirehoseEventType } from './AtIngressEvents.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DecodedFirehoseHeader {
  /** Classified event type. */
  eventType: AtFirehoseEventType;

  /** ATProto sequence number. */
  seq: number;

  /** DID extracted cheaply from the header/body, if available. */
  did?: string | null;
}

export interface AtFirehoseDecoder {
  /**
   * Decode only the frame header to classify the event and extract the
   * sequence number.  This is a cheap operation performed on every frame.
   *
   * @throws {FirehoseDecodeError} if the frame cannot be parsed at all.
   */
  decodeHeader(frame: Uint8Array): DecodedFirehoseHeader;

  /**
   * Fully decode a frame into its header and body.  This is an expensive
   * operation performed only by the verifier on relevant frames.
   *
   * @throws {FirehoseDecodeError} if the frame cannot be parsed.
   */
  decodeFull(frame: Uint8Array): unknown;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class FirehoseDecodeError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FirehoseDecodeError';
  }
}

// ---------------------------------------------------------------------------
// ATProto event type mapping
// ---------------------------------------------------------------------------

/**
 * Maps the "t" field in the CBOR header to our typed enum.
 * Unknown values are treated as '#info' (tolerated, non-fatal).
 */
function classifyEventType(t: unknown): AtFirehoseEventType {
  switch (t) {
    case '#commit':   return '#commit';
    case '#identity': return '#identity';
    case '#account':  return '#account';
    case '#sync':     return '#sync';
    case '#info':     return '#info';
    default:          return '#info'; // tolerate unknown control frames
  }
}

/**
 * Validate a DID string.  Returns the DID if valid, null otherwise.
 * Does not perform full DID resolution — only structural validation.
 */
function validateDid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('did:')) return null;
  // Basic structural check: did:<method>:<method-specific>
  const parts = value.split(':');
  if (parts.length < 3) return null;
  // Prevent excessively long DIDs (spec allows up to 2048 chars)
  if (value.length > 2048) return null;
  return value;
}

/**
 * Validate and clamp a sequence number.
 * The ATProto spec uses 64-bit integers; JavaScript handles up to 2^53 safely.
 */
function validateSeq(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value < 0n) return -1;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1;
  if (value < 0) return -1;
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtFirehoseDecoder implements AtFirehoseDecoder {
  decodeHeader(frame: Uint8Array): DecodedFirehoseHeader {
    if (!frame || frame.length === 0) {
      throw new FirehoseDecodeError('Empty frame received');
    }

    try {
      const [header, remaining] = decodeFirstValue(frame);
      const headerMap = requireMap(header, 'Frame header is not a CBOR map');
      validateHeaderMap(headerMap);

      // "t" is the event type field in the ATProto firehose header.
      const eventType = classifyEventType(headerMap['t']);

      let seq = validateSeq(headerMap['seq']);
      if (remaining.length === 0) {
        throw new FirehoseDecodeError('Frame payload is missing');
      }

      const [body, trailing] = decodeFirstValue(remaining);
      if (trailing.length > 0) {
        throw new FirehoseDecodeError('Frame contains trailing bytes after payload');
      }
      const bodyMap = requireMap(body, 'Frame payload is not a CBOR map');

      if (seq === -1) {
        seq = validateSeq(bodyMap['seq']);
      }
      const did = validateDid(bodyMap['did'] ?? bodyMap['repo']);

      return { eventType, seq, did };
    } catch (err) {
      if (err instanceof FirehoseDecodeError) throw err;
      throw new FirehoseDecodeError('Failed to decode frame header', err);
    }
  }

  decodeFull(frame: Uint8Array): unknown {
    if (!frame || frame.length === 0) {
      throw new FirehoseDecodeError('Empty frame received');
    }

    try {
      const [header, remaining] = decodeFirstValue(frame);
      const headerMap = requireMap(header, 'Frame header is not a CBOR map');
      validateHeaderMap(headerMap);

      if (remaining.length === 0) {
        throw new FirehoseDecodeError('Frame payload is missing');
      }

      const [body, trailing] = decodeFirstValue(remaining);
      if (trailing.length > 0) {
        throw new FirehoseDecodeError('Frame contains trailing bytes after payload');
      }
      const bodyMap = requireMap(body, 'Frame payload is not a CBOR map');

      return { header: headerMap, body: bodyMap };
    } catch (err) {
      if (err instanceof FirehoseDecodeError) throw err;
      throw new FirehoseDecodeError('Failed to fully decode frame', err);
    }
  }
}

const CBOR_TAGS: Array<((value: unknown) => unknown) | undefined> = [];
CBOR_TAGS[42] = decodeCidTag;

const CBOR_DECODE_OPTIONS = {
  strict: true,
  allowUndefined: false,
  allowIndefinite: false,
  allowNaN: false,
  allowInfinity: false,
  allowBigInt: true,
  rejectDuplicateMapKeys: true,
  tags: CBOR_TAGS,
};

function decodeFirstValue(data: Uint8Array): [unknown, Uint8Array] {
  try {
    const [value, remainder] = decodeCborFirst(data, CBOR_DECODE_OPTIONS);
    return [value, Uint8Array.from(remainder)];
  } catch (error) {
    throw new FirehoseDecodeError('Invalid DRISL-CBOR frame', error);
  }
}

function decodeCidTag(value: unknown): CID {
  if (!(value instanceof Uint8Array)) {
    throw new FirehoseDecodeError('Invalid CID tag payload; expected byte array');
  }
  if (value.length < 2 || value[0] !== 0x00) {
    throw new FirehoseDecodeError('Invalid CID tag payload; expected 0x00-prefixed CID bytes');
  }
  try {
    return CID.decode(value.subarray(1));
  } catch (error) {
    throw new FirehoseDecodeError('Invalid CID tag payload; failed to decode CID', error);
  }
}

function requireMap(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new FirehoseDecodeError(message);
  }
  return value as Record<string, unknown>;
}

function validateHeaderMap(header: Record<string, unknown>): void {
  const op = header['op'];
  if (typeof op !== 'number' || !Number.isInteger(op)) {
    throw new FirehoseDecodeError('Frame header is missing a valid op field');
  }
  if (op === 1 && typeof header['t'] !== 'string') {
    throw new FirehoseDecodeError('Message frame header is missing a valid t field');
  }
  if (op !== 1 && op !== -1) {
    // Unknown op values are tolerated and later classified as #info.
    return;
  }
  if (op === -1 && 't' in header && typeof header['t'] !== 'string') {
    throw new FirehoseDecodeError('Error frame header contains an invalid t field');
  }
}
