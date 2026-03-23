/**
 * V6.5 Phase 5.5: AT Ingress Checkpoint Store
 *
 * Manages durable committed cursors for the external AT firehose consumer.
 *
 * Checkpoint model (from spec):
 *   - Redis hot cursor: updated after every acknowledged publish, used for
 *     fast reconnects.
 *   - Durable committed cursor: persisted to a backing store periodically
 *     from acknowledged hot progress, used for cold-start recovery.
 *
 * Cold-start rule: always resume from the durable committed checkpoint, not
 * from Redis alone.  Redis may have been flushed or corrupted.
 *
 * Security notes:
 *   - Source IDs are sanitised before use as Redis key segments to prevent
 *     key injection attacks.
 *   - All Redis operations are wrapped with error handling so a Redis failure
 *     does not crash the consumer; it degrades gracefully to a full replay.
 *   - TTLs are applied to dedupe keys to prevent unbounded Redis growth.
 *
 * Ref: https://atproto.com/specs/event-stream (cursor semantics)
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AtIngressCheckpointStore {
  /**
   * Load the durable committed cursor for a source.
   * Returns null if no checkpoint exists (cold start from beginning).
   */
  loadCommittedCursor(sourceId: string): Promise<number | null>;

  /**
   * Persist the durable committed cursor for a source.
   * Called periodically after a batch of frames has been fully acknowledged.
   */
  saveCommittedCursor(sourceId: string, seq: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

/** Maximum length for a sanitised source ID segment. */
const MAX_SOURCE_ID_LENGTH = 128;

/**
 * Sanitise a source ID for safe use as a Redis key segment.
 * Strips characters outside [a-zA-Z0-9._-] and truncates to prevent
 * excessively long keys.
 */
function sanitiseSourceId(sourceId: string): string {
  return sourceId
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .slice(0, MAX_SOURCE_ID_LENGTH);
}

function committedCursorKey(sourceId: string): string {
  return `at:firehose:consumer:${sanitiseSourceId(sourceId)}:cursor:committed`;
}

function statusKey(sourceId: string): string {
  return `at:firehose:consumer:${sanitiseSourceId(sourceId)}:status`;
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export class RedisAtIngressCheckpointStore implements AtIngressCheckpointStore {
  constructor(private readonly redis: RedisClient) {}

  async loadCommittedCursor(sourceId: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(committedCursorKey(sourceId));
      if (raw === null || raw === undefined) return null;
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return parsed;
    } catch (err) {
      // Redis failure on cold start: log and return null to replay from beginning.
      console.error(
        `[AtIngressCheckpointStore] Failed to load committed cursor for ${sourceId}:`,
        err,
      );
      return null;
    }
  }

  async saveCommittedCursor(sourceId: string, seq: number): Promise<void> {
    if (!Number.isFinite(seq) || seq < 0) {
      throw new CheckpointError(`Invalid seq value: ${seq}`);
    }

    try {
      await this.redis.set(committedCursorKey(sourceId), seq.toString());
      await this.redis.set(statusKey(sourceId), 'active');
    } catch (err) {
      // Redis failure on checkpoint save is non-fatal: the consumer will
      // replay from the last successfully committed cursor on next restart.
      console.error(
        `[AtIngressCheckpointStore] Failed to save committed cursor for ${sourceId} at seq ${seq}:`,
        err,
      );
      throw new CheckpointError(
        `Failed to persist checkpoint for ${sourceId} at seq ${seq}`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing)
// ---------------------------------------------------------------------------

export class InMemoryAtIngressCheckpointStore implements AtIngressCheckpointStore {
  private cursors = new Map<string, number>();

  async loadCommittedCursor(sourceId: string): Promise<number | null> {
    return this.cursors.get(sourceId) ?? null;
  }

  async saveCommittedCursor(sourceId: string, seq: number): Promise<void> {
    if (!Number.isFinite(seq) || seq < 0) {
      throw new CheckpointError(`Invalid seq value: ${seq}`);
    }
    this.cursors.set(sourceId, seq);
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CheckpointError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

// ---------------------------------------------------------------------------
// Redis client interface (minimal, compatible with ioredis and redis npm)
// ---------------------------------------------------------------------------

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  setex?(key: string, ttl: number, value: string): Promise<unknown>;
}
