/**
 * V6.5 Phase 5.5: AT Firehose Cursor Manager
 *
 * Manages both the hot (Redis) cursor and the durable committed cursor for
 * each external AT firehose source.
 *
 * Cursor lifecycle:
 *   1. On connect: load durable committed cursor → use as WebSocket cursor param.
 *   2. On frame publish ack: advance hot cursor in Redis.
 *   3. Periodically (every COMMIT_INTERVAL_MS): flush hot cursor to durable store.
 *   4. On crash/restart: resume from durable committed cursor (never Redis alone).
 *
 * The ATProto sync spec defines seq as the reliable cursor field and expects
 * consumers to bias toward duplicates over loss on replay.
 *
 * Security notes:
 *   - Source IDs are sanitised before use as Redis key segments.
 *   - Cursor values are validated as non-negative finite integers.
 *   - Periodic flush uses a debounced timer to prevent thundering-herd on
 *     high-throughput streams.
 *
 * Ref: https://atproto.com/specs/event-stream
 */

import { AtIngressCheckpointStore } from './AtIngressCheckpointStore';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AtFirehoseCursorManager {
  /**
   * Get the current hot cursor (Redis) for a source.
   * Returns null if no cursor has been set yet.
   */
  getHotCursor(sourceId: string): Promise<number | null>;

  /**
   * Get the current durable committed cursor for a source.
   * Returns null if no checkpoint exists (cold start).
   */
  getCommittedCursor(sourceId: string): Promise<number | null>;

  /**
   * Advance the hot cursor after a frame has been acknowledged by RedPanda.
   * Does NOT write to the durable store — use commitCursor for that.
   */
  setHotCursor(sourceId: string, seq: number): Promise<void>;

  /**
   * Flush the current hot cursor to the durable committed checkpoint store.
   * Should be called periodically or on graceful shutdown.
   */
  commitCursor(sourceId: string, seq: number): Promise<void>;

  /**
   * Load the resume cursor for a source on startup.
   * Prefers the durable committed cursor over the hot Redis cursor.
   */
  getResumeCursor(sourceId: string): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const MAX_SOURCE_ID_LENGTH = 128;

function sanitiseSourceId(sourceId: string): string {
  return sourceId
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .slice(0, MAX_SOURCE_ID_LENGTH);
}

function hotCursorKey(sourceId: string): string {
  return `at:firehose:consumer:${sanitiseSourceId(sourceId)}:cursor:hot`;
}

function lastEventAtKey(sourceId: string): string {
  return `at:firehose:consumer:${sanitiseSourceId(sourceId)}:lastEventAt`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtFirehoseCursorManager implements AtFirehoseCursorManager {
  constructor(
    private readonly redis: RedisCursorClient,
    private readonly checkpointStore: AtIngressCheckpointStore,
  ) {}

  async getHotCursor(sourceId: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(hotCursorKey(sourceId));
      if (raw === null || raw === undefined) return null;
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } catch (err) {
      console.error(`[CursorManager] Failed to get hot cursor for ${sourceId}:`, err);
      return null;
    }
  }

  async getCommittedCursor(sourceId: string): Promise<number | null> {
    return this.checkpointStore.loadCommittedCursor(sourceId);
  }

  async setHotCursor(sourceId: string, seq: number): Promise<void> {
    validateSeq(seq, sourceId);
    try {
      await this.redis.set(hotCursorKey(sourceId), seq.toString());
      await this.redis.set(lastEventAtKey(sourceId), new Date().toISOString());
    } catch (err) {
      // Hot cursor failure is non-fatal; the consumer continues processing.
      // The durable cursor will catch up on the next commit interval.
      console.error(
        `[CursorManager] Failed to set hot cursor for ${sourceId} at seq ${seq}:`,
        err,
      );
    }
  }

  async commitCursor(sourceId: string, seq: number): Promise<void> {
    validateSeq(seq, sourceId);
    await this.checkpointStore.saveCommittedCursor(sourceId, seq);
  }

  async getResumeCursor(sourceId: string): Promise<number | null> {
    // Cold-start rule: always prefer the durable committed cursor.
    const committed = await this.checkpointStore.loadCommittedCursor(sourceId);
    if (committed !== null) return committed;

    // Fall back to hot cursor only if no durable checkpoint exists.
    // This handles the case of a first-ever start with no committed state.
    return this.getHotCursor(sourceId);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing)
// ---------------------------------------------------------------------------

export class InMemoryAtFirehoseCursorManager implements AtFirehoseCursorManager {
  private hotCursors = new Map<string, number>();
  private committedCursors = new Map<string, number>();

  async getHotCursor(sourceId: string): Promise<number | null> {
    return this.hotCursors.get(sourceId) ?? null;
  }

  async getCommittedCursor(sourceId: string): Promise<number | null> {
    return this.committedCursors.get(sourceId) ?? null;
  }

  async setHotCursor(sourceId: string, seq: number): Promise<void> {
    validateSeq(seq, sourceId);
    this.hotCursors.set(sourceId, seq);
  }

  async commitCursor(sourceId: string, seq: number): Promise<void> {
    validateSeq(seq, sourceId);
    this.committedCursors.set(sourceId, seq);
  }

  async getResumeCursor(sourceId: string): Promise<number | null> {
    return this.committedCursors.get(sourceId) ?? this.hotCursors.get(sourceId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function validateSeq(seq: number, sourceId: string): void {
  if (!Number.isFinite(seq) || seq < 0 || !Number.isInteger(seq)) {
    throw new CursorError(`Invalid seq value ${seq} for source ${sourceId}`);
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CursorError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CursorError';
  }
}

// ---------------------------------------------------------------------------
// Redis client interface
// ---------------------------------------------------------------------------

export interface RedisCursorClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}
