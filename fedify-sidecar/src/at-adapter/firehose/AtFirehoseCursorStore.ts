/**
 * V6.5 Phase 4: AT Firehose Cursor Store
 *
 * Stores encoded firehose event envelopes and supports cursor-based replay.
 *
 * Durability contract (V6 architecture rule):
 *   Redis MUST NOT be used as the authoritative replay source.
 *   In production, envelopes should be persisted to RedPanda (append-only) or
 *   a durable write-ahead store.  The in-memory implementation below is
 *   suitable for testing and single-process deployments only.
 *
 * Cursor semantics:
 *   readFrom(cursorExclusive, limit) returns events with seq > cursorExclusive.
 *   If the cursor is beyond the available window, an empty array is returned
 *   and the caller should force a rebootstrap via getRepo.
 *
 * Ref: https://atproto.com/specs/event-stream#sequence-numbers
 */

export interface FirehoseEventEnvelope {
  seq: number;
  type: '#commit' | '#identity' | '#account';
  encoded: Uint8Array;
  emittedAt: string;
}

export interface AtFirehoseCursorStore {
  append(event: FirehoseEventEnvelope): Promise<void>;
  readFrom(cursorExclusive: number, limit: number): Promise<FirehoseEventEnvelope[]>;
  latestSeq(): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (testing / single-process)
// ---------------------------------------------------------------------------

export class InMemoryAtFirehoseCursorStore implements AtFirehoseCursorStore {
  private readonly events: FirehoseEventEnvelope[] = [];
  private seq = 0;

  async append(event: FirehoseEventEnvelope): Promise<void> {
    this.events.push(event);
    if (event.seq > this.seq) this.seq = event.seq;
  }

  async readFrom(cursorExclusive: number, limit: number): Promise<FirehoseEventEnvelope[]> {
    if (limit < 1) return [];
    const start = this.events.findIndex(e => e.seq > cursorExclusive);
    if (start === -1) return [];
    return this.events.slice(start, start + limit);
  }

  async latestSeq(): Promise<number> {
    return this.seq;
  }
}
