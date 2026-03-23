/**
 * V6.5 Phase 4: AT Firehose Event Encoder
 *
 * Encodes firehose events into wire payloads for the subscribeRepos WebSocket
 * stream.
 *
 * Encoding requirement (ATProto spec):
 *   The subscribeRepos stream uses CBOR-encoded messages, NOT JSON.
 *   Each message is a two-element CBOR array: [header, body], where:
 *     - header is a CBOR map with an "op" field (1 = message, -1 = error)
 *       and a "t" field containing the event type string.
 *     - body is a CBOR map with the event fields.
 *
 * Phase 4 implementation note:
 *   A full CBOR implementation requires the "cborg" or "@ipld/dag-cbor"
 *   library.  The current implementation encodes to JSON-in-Uint8Array as a
 *   structural placeholder.  The interface contract is correct; swap the
 *   private _encode method for real CBOR once the dependency is added.
 *
 * TODO: Install cborg and replace _encode with real CBOR encoding.
 *
 * Ref: https://atproto.com/specs/event-stream
 */

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
   * Placeholder encoder — produces JSON bytes.
   * Replace with CBOR: encode([ { op: 1, t: type }, body ]) using cborg.
   */
  private _encode(type: string, body: any): Uint8Array {
    const serialisable = JSON.parse(
      JSON.stringify(body, (_key, value) => {
        if (value instanceof Uint8Array) {
          return { $bytes: Buffer.from(value).toString('base64') };
        }
        return value;
      })
    );
    const envelope = { header: { op: 1, t: type }, body: serialisable };
    return new Uint8Array(Buffer.from(JSON.stringify(envelope)));
  }
}
