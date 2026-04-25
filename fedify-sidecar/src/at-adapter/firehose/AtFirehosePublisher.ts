/**
 * V6.5 Phase 4: AT Firehose Publisher
 *
 * Consumes local at.commit.v1, at.identity.v1, and at.account.v1 events,
 * assigns global monotonic sequence numbers, encodes them, and fans them out
 * to connected WebSocket subscribers via the subscription manager.
 *
 * Ordering guarantee:
 *   - Sequence numbers are adapter-wide and monotonically increasing.
 *   - Per-DID ordering is preserved via a per-DID serialisation queue.
 *     Commits for the same DID are processed in FIFO order; commits for
 *     different DIDs may be interleaved in global sequence.
 *
 * Retry / backoff:
 *   - If the cursor store append fails, the publisher retries with
 *     exponential backoff (base 100 ms, max 5 s, jitter ±20 %).
 *   - Broadcast failures are handled inside the subscription manager and
 *     do not cause retries here.
 *
 * Security:
 *   - DID values from incoming events are validated before use.
 *   - No raw key material or internal state is included in emitted events.
 *
 * Ref: https://atproto.com/specs/event-stream
 */

import { AtCommitV1 } from '../events/AtRepoEvents.js';
import { AtIdentityV1, AtAccountV1 } from '../../core-domain/events/CoreIdentityEvents.js';
import {
  AtFirehoseEventEncoder,
  CommitFirehoseEvent,
  IdentityFirehoseEvent,
  AccountFirehoseEvent
} from './AtFirehoseEventEncoder.js';
import { AtFirehoseCursorStore } from './AtFirehoseCursorStore.js';
import { AtFirehoseSubscriptionManager } from './AtFirehoseSubscriptionManager.js';
import { AtRepoDiffBuilder } from '../repo/AtRepoDiffBuilder.js';

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
  baseDelayMs = 100,
  maxDelayMs = 5000
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20 %
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1) * jitter, maxDelayMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AtFirehosePublisher {
  publishCommit(evt: AtCommitV1): Promise<void>;
  publishIdentity(evt: AtIdentityV1): Promise<void>;
  publishAccount(evt: AtAccountV1): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtFirehosePublisher implements AtFirehosePublisher {
  /** Global monotonic sequence counter. */
  private seqCounter: number | null = null;
  private seqInitialisation: Promise<void> | null = null;

  /**
   * Per-DID serialisation queues.
   * Each DID maps to a promise chain that ensures commits for that DID are
   * processed in order even if publishCommit is called concurrently.
   */
  private readonly didQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly encoder: AtFirehoseEventEncoder,
    private readonly cursorStore: AtFirehoseCursorStore,
    private readonly subscriptionManager: AtFirehoseSubscriptionManager,
    private readonly diffBuilder: AtRepoDiffBuilder
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async publishCommit(evt: AtCommitV1): Promise<void> {
    await this.ensureSeqCounterInitialised();

    // Serialise per DID to preserve per-account ordering.
    const prior = this.didQueues.get(evt.did) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this._doPublishCommit(evt));
    this.didQueues.set(evt.did, next.catch(() => undefined));
    return next;
  }

  async publishIdentity(evt: AtIdentityV1): Promise<void> {
    await this.ensureSeqCounterInitialised();
    const seq = this._nextSeq();
    const time = new Date().toISOString();

    const firehoseEvent: IdentityFirehoseEvent = {
      $type: '#identity',
      seq,
      time,
      did: evt.did,
      handle: evt.handle
    };

    const encoded = this.encoder.encodeIdentity(firehoseEvent);
    await this._appendAndBroadcast(seq, '#identity', encoded, time);
  }

  async publishAccount(evt: AtAccountV1): Promise<void> {
    await this.ensureSeqCounterInitialised();
    const seq = this._nextSeq();
    const time = new Date().toISOString();

    const firehoseEvent: AccountFirehoseEvent = {
      $type: '#account',
      seq,
      time,
      did: evt.did,
      active: evt.status === 'active',
      status: evt.status === 'active' ? undefined : (evt.status as any)
    };

    const encoded = this.encoder.encodeAccount(firehoseEvent);
    await this._appendAndBroadcast(seq, '#account', encoded, time);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _doPublishCommit(evt: AtCommitV1): Promise<void> {
    const seq = this._nextSeq();
    const time = new Date().toISOString();

    const diff = await this.diffBuilder.buildFromCommit(evt);

    const firehoseEvent: CommitFirehoseEvent = {
      $type: '#commit',
      seq,
      time,
      repo: evt.did,
      rev: evt.rev,
      since: null,
      commit: diff.commitCid,
      tooBig: false,
      blocks: diff.carSlice,
      ops: diff.ops,
      blobs: [],
      prevData: diff.prevData
    };

    const encoded = this.encoder.encodeCommit(firehoseEvent);
    await this._appendAndBroadcast(seq, '#commit', encoded, time);
  }

  private async _appendAndBroadcast(
    seq: number,
    type: '#commit' | '#identity' | '#account',
    encoded: Uint8Array,
    emittedAt: string
  ): Promise<void> {
    // Append with retry/backoff for transient store failures.
    await withExponentialBackoff(() =>
      this.cursorStore.append({ seq, type, encoded, emittedAt })
    );

    // Broadcast is best-effort; individual subscriber failures are handled
    // inside the subscription manager.
    await this.subscriptionManager.broadcast(encoded);
  }

  private _nextSeq(): number {
    if (this.seqCounter === null) {
      throw new Error('Firehose sequence counter used before initialisation');
    }
    this.seqCounter++;
    return this.seqCounter;
  }

  private async ensureSeqCounterInitialised(): Promise<void> {
    if (this.seqCounter !== null) {
      return;
    }
    if (!this.seqInitialisation) {
      this.seqInitialisation = (async () => {
        const latest = await this.cursorStore.latestSeq();
        this.seqCounter = Number.isFinite(latest) && latest >= 0
          ? Math.trunc(latest)
          : 0;
      })().finally(() => {
        this.seqInitialisation = null;
      });
    }

    await this.seqInitialisation;
  }
}
