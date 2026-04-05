/**
 * V6.5 Phase 4: AT Firehose Event Encoder
 *
 * Encodes firehose events into wire payloads for the subscribeRepos WebSocket
 * stream.
 *
 * Encoding requirement (ATProto spec):
 *   The subscribeRepos stream uses CBOR-encoded messages, NOT JSON.
 *   Each message is two concatenated CBOR values: header followed by body.
 *   The header is a CBOR map containing:
 *     - header is a CBOR map with an "op" field (1 = message, -1 = error)
 *       and a "t" field containing the event type string.
 *     - body is a second CBOR map with the event fields.
 *
 * Ref: https://atproto.com/specs/event-stream
 */

import { encode as encodeCbor } from 'cborg';

export interface FirehoseEventBase {
  seq: number;
  time: string;
}

export interface CommitFirehoseEvent extends FirehoseEventBase {
  $type: '#commit';
  repo: string;
  rev: string;
  since: string | null;
  commit: string;
  tooBig: false;
  blocks: Uint8Array;
  ops: Array<{
    action: 'create' | 'update' | 'delete';
    path: string;
    cid: string | null;
    prev?: string;
  }>;
  blobs: [];
  prevData?: string | null;
}

export interface IdentityFirehoseEvent extends FirehoseEventBase {
  $type: '#identity';
  did: string;
  handle?: string;
}

export interface AccountFirehoseEvent extends FirehoseEventBase {
  $type: '#account';
  did: string;
  active: boolean;
  status?: 'takendown' | 'suspended' | 'deleted' | 'deactivated';
}

export interface AtFirehoseEventEncoder {
  encodeCommit(evt: CommitFirehoseEvent): Uint8Array;
  encodeIdentity(evt: IdentityFirehoseEvent): Uint8Array;
  encodeAccount(evt: AccountFirehoseEvent): Uint8Array;
}

export class DefaultAtFirehoseEventEncoder implements AtFirehoseEventEncoder {
  encodeCommit(evt: CommitFirehoseEvent): Uint8Array {
    return this._encode('#commit', evt);
  }

  encodeIdentity(evt: IdentityFirehoseEvent): Uint8Array {
    return this._encode('#identity', evt);
  }

  encodeAccount(evt: AccountFirehoseEvent): Uint8Array {
    return this._encode('#account', evt);
  }

  /**
   * Encodes the event into the ATProto wire format: two concatenated
   * DRISL-CBOR objects (header map, then body map).
   */
  private _encode<T extends { $type?: string } & object>(type: string, body: T): Uint8Array {
    const header = { op: 1, t: type };
    const { $type: _ignoredType, ...payload } = body;
    return concatBytes(encodeCbor(header), encodeCbor(payload));
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}
