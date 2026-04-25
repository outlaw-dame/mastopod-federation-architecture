/**
 * V6.5 Phase 4: AT Firehose Subscription Manager
 *
 * Manages WebSocket subscriber lifecycle for the subscribeRepos stream.
 *
 * Ordering guarantee:
 *   Events are delivered to each subscriber in the order they were appended
 *   to the cursor store.  Per-subscriber send failures are isolated: one
 *   slow or broken client cannot block delivery to healthy clients.
 *
 * Backfill / replay:
 *   On attach, if the subscriber supplies a cursor, the manager replays all
 *   events after that cursor before switching to live delivery.  Replay is
 *   performed in batches to bound memory usage.
 *
 * Error handling:
 *   - A send failure triggers immediate subscriber detachment.
 *   - Replay failures close the WebSocket with code 1008 (Policy Violation)
 *     and a human-readable reason, so the client knows to rebootstrap.
 *   - Broadcast uses Promise.allSettled so one bad subscriber never prevents
 *     delivery to the rest.
 *
 * Security:
 *   - Subscriber IDs are validated to be non-empty strings before insertion.
 *   - Cursor values are validated to be non-negative integers.
 */

import { AtFirehoseCursorStore } from './AtFirehoseCursorStore.js';

export interface FirehoseSubscriber {
  id: string;
  cursor?: number;
  send(data: Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface AtFirehoseSubscriptionManager {
  attach(subscriber: FirehoseSubscriber): Promise<void>;
  detach(subscriberId: string): Promise<void>;
  broadcast(encoded: Uint8Array): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPLAY_BATCH_SIZE = 100;
const WS_CLOSE_POLICY_VIOLATION = 1008;
const WS_CLOSE_NORMAL = 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtFirehoseSubscriptionManager implements AtFirehoseSubscriptionManager {
  private readonly subscribers = new Map<string, FirehoseSubscriber>();

  constructor(private readonly cursorStore: AtFirehoseCursorStore) {}

  async attach(subscriber: FirehoseSubscriber): Promise<void> {
    if (!subscriber.id || typeof subscriber.id !== 'string') {
      throw new Error('Subscriber id must be a non-empty string');
    }

    // Validate cursor if provided.
    if (subscriber.cursor !== undefined) {
      if (!Number.isInteger(subscriber.cursor) || subscriber.cursor < 0) {
        await subscriber.close(WS_CLOSE_POLICY_VIOLATION, 'Invalid cursor: must be a non-negative integer');
        return;
      }
    }

    this.subscribers.set(subscriber.id, subscriber);

    if (subscriber.cursor !== undefined) {
      try {
        await this._replayBacklog(subscriber);
      } catch (err) {
        // Replay failed — close the connection and remove the subscriber.
        this.subscribers.delete(subscriber.id);
        await subscriber.close(
          WS_CLOSE_POLICY_VIOLATION,
          'Replay failed or cursor is too old. Rebootstrap via getRepo.'
        );
      }
    }
  }

  async detach(subscriberId: string): Promise<void> {
    this.subscribers.delete(subscriberId);
  }

  async broadcast(encoded: Uint8Array): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.subscribers.values()).map(sub =>
        sub.send(encoded).catch(async err => {
          // Isolate the failure: detach the subscriber and do not rethrow.
          this.subscribers.delete(sub.id);
          try {
            await sub.close(WS_CLOSE_NORMAL, 'Send error');
          } catch {
            // Ignore close errors.
          }
          throw err; // Propagate into allSettled so we can log if needed.
        })
      )
    );

    // Log any broadcast failures without crashing the publisher.
    for (const result of results) {
      if (result.status === 'rejected' && process.env["NODE_ENV"] !== 'test') {
        console.error('[AtFirehoseSubscriptionManager] Broadcast send error:', result.reason);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _replayBacklog(subscriber: FirehoseSubscriber): Promise<void> {
    if (subscriber.cursor === undefined) return;

    let cursor = subscriber.cursor;

    while (true) {
      const batch = await this.cursorStore.readFrom(cursor, REPLAY_BATCH_SIZE);
      if (batch.length === 0) break;

      for (const event of batch) {
        await subscriber.send(event.encoded);
        cursor = event.seq;
      }

      if (batch.length < REPLAY_BATCH_SIZE) break;
    }
  }
}
