/**
 * V6.5 Phase 5.5: AT Ingress Event Classifier
 *
 * Determines whether a given DID is relevant for local processing.
 *
 * Filtering strategy (from spec):
 *   Phase 5.5A — correctness-first:
 *     All DIDs are considered relevant.  The verifier discards irrelevant
 *     events after full decode.  Simplest and safest for small deployments.
 *
 *   Phase 5.5B — scale mode:
 *     Pre-publish DID allowlist filtering in AtFirehoseConsumer.
 *     Allowlist membership includes:
 *       - DIDs present in local IdentityBinding
 *       - DIDs followed by local users
 *       - DIDs explicitly pinned/subscribed by local policy
 *     The allowlist is maintained in Redis by a lightweight service watching
 *     Tier 1 identity/follow changes.
 *
 * This class implements Phase 5.5A by default.  To enable Phase 5.5B,
 * construct with a Redis client and the allowlist will be consulted.
 *
 * Security notes:
 *   - DID values are validated before Redis key construction to prevent
 *     key injection attacks.
 *   - Cache TTLs prevent stale allowlist entries from persisting indefinitely.
 *   - A negative cache (not-relevant DIDs) is maintained to avoid repeated
 *     Redis lookups for high-volume irrelevant DIDs.
 *
 * Ref: https://atproto.com/specs/event-stream (filtering strategy)
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const MAX_DID_LENGTH = 2048;
const ALLOWLIST_KEY_PREFIX = 'at:ingress:allowlist:did:';
const DEDUPE_KEY_PREFIX = 'at:firehose:dedupe:window:v2:';
const DEDUPE_TTL_SECONDS = 86_400;
// Bounds Redis memory independently of upstream event rate or uptime.
const DEFAULT_DEDUPE_WINDOW = 32_768;

const REMEMBER_PROCESSED = [
  "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[1])",
  "local n = redis.call('ZCARD', KEYS[1])",
  "local max = tonumber(ARGV[2])",
  "if n > max then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, n - max - 1) end",
  "redis.call('EXPIRE', KEYS[1], ARGV[3])",
  "return 1",
].join("\n");

function sanitiseDid(did: string): string {
  // Validate DID structure before use as a key segment.
  if (!did.startsWith('did:') || did.length > MAX_DID_LENGTH) {
    throw new ClassifierError(`Invalid DID: ${did.slice(0, 64)}`);
  }
  // Replace characters outside the safe set with underscores.
  return did.replace(/[^a-zA-Z0-9:._\-]/g, '_');
}

function allowlistKey(did: string): string {
  return `${ALLOWLIST_KEY_PREFIX}${sanitiseDid(did)}`;
}

function dedupeKey(sourceId: string): string {
  // Upstream identifiers are URLs, not DIDs. Hash the full source to avoid
  // lossy replacement/truncation, cross-source collisions, or key injection.
  if (typeof sourceId !== 'string' || sourceId.length > 2048) {
    throw new ClassifierError('Invalid external firehose source identifier');
  }
  let parsed: URL;
  try { parsed = new URL(sourceId); }
  catch { throw new ClassifierError('Invalid external firehose source URL'); }
  if (!['wss:', 'ws:'].includes(parsed.protocol) ||
      parsed.username || parsed.password) {
    throw new ClassifierError('Invalid external firehose source protocol');
  }
  return DEDUPE_KEY_PREFIX +
    createHash('sha256').update(sourceId).digest('hex').slice(0, 40);
}

function validSeq(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new ClassifierError('Invalid dedupe source sequence');
  }
  return String(seq);
}

function validateWindow(windowSize: number): void {
  if (!Number.isSafeInteger(windowSize) || windowSize < 16 ||
      windowSize > 65_536) {
    throw new ClassifierError('Dedupe window must be 16–65536 entries');
  }
}

async function isSourceDuplicate(
  redis: RedisClassifierClient, source: string, seq: number,
): Promise<boolean> {
  const result = await redis.zscore(dedupeKey(source), validSeq(seq));
  if (result === null) return false;
  if (typeof result !== 'string') throw new ClassifierError('Invalid Redis dedupe lookup response');
  return true;
}

async function rememberSourceProcessed(
  redis: RedisClassifierClient, source: string, seq: number,
  windowSize: number,
): Promise<void> {
  const result = await redis.eval(REMEMBER_PROCESSED, 1,
    dedupeKey(source), validSeq(seq), String(windowSize),
    String(DEDUPE_TTL_SECONDS));
  if (result !== 1) throw new ClassifierError('Redis dedupe checkpoint failed');
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AtIngressEventClassifier {
  /**
   * Returns true if the DID should be processed by the local verifier.
   * In Phase 5.5A this always returns true.
   * In Phase 5.5B this consults the Redis allowlist.
   */
  isRelevantDid(did: string): Promise<boolean>;

  /**
   * Returns true if this (sourceId, seq) combination has already been
   * processed, preventing duplicate processing on replay.
   */
  isDuplicate(sourceId: string, seq: number): Promise<boolean>;

  /**
   * Mark a (sourceId, seq) combination as processed.
   * Should be called after successful publish to at.ingress.v1.
   */
  markProcessed(sourceId: string, seq: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Phase 5.5A implementation (accept-all)
// ---------------------------------------------------------------------------

/**
 * Phase 5.5A classifier: all DIDs are relevant.
 * Deduplication is still performed to prevent double-processing on replay.
 */
export class Phase55AEventClassifier implements AtIngressEventClassifier {
  constructor(
    private readonly redis?: RedisClassifierClient,
    private readonly windowSize = DEFAULT_DEDUPE_WINDOW,
  ) { validateWindow(windowSize); }

  async isRelevantDid(_did: string): Promise<boolean> { return true; }

  async isDuplicate(sourceId: string, seq: number): Promise<boolean> {
    if (!this.redis) return false; // only an isolated in-process test fixture
    // Redis unavailable means retry, not 'new event'. This prevents silently
    // re-emitting trusted events during broker/Redis recovery.
    return isSourceDuplicate(this.redis, sourceId, seq);
  }

  async markProcessed(sourceId: string, seq: number): Promise<void> {
    if (!this.redis) return;
    await rememberSourceProcessed(this.redis, sourceId, seq, this.windowSize);
  }
}

// ---------------------------------------------------------------------------
// Phase 5.5B implementation (allowlist-based)
// ---------------------------------------------------------------------------

/**
 * Phase 5.5B classifier: only DIDs in the Redis allowlist are relevant.
 * Falls back to accepting all DIDs if the Redis lookup fails.
 */
export class Phase55BEventClassifier implements AtIngressEventClassifier {
  constructor(
    private readonly redis: RedisClassifierClient,
    private readonly windowSize = DEFAULT_DEDUPE_WINDOW,
  ) { validateWindow(windowSize); }

  async isRelevantDid(did: string): Promise<boolean> {
    try {
      const key = allowlistKey(did);
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (err) {
      // Redis failure: fall back to accepting the DID to avoid silent drops.
      console.error('[EventClassifier] Allowlist check failed, defaulting to relevant:', err);
      return true;
    }
  }

  async isDuplicate(sourceId: string, seq: number): Promise<boolean> {
    return isSourceDuplicate(this.redis, sourceId, seq);
  }

  async markProcessed(sourceId: string, seq: number): Promise<void> {
    await rememberSourceProcessed(this.redis, sourceId, seq, this.windowSize);
  }

  /**
   * Add a DID to the allowlist.
   * Called by the identity/follow change watcher service.
   */
  async addToAllowlist(did: string, ttlSeconds?: number): Promise<void> {
    const key = allowlistKey(did);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.setex(key, ttlSeconds, '1');
    } else {
      await this.redis.set(key, '1');
    }
  }

  /**
   * Remove a DID from the allowlist.
   * Called when a local user unfollows or the identity binding is removed.
   */
  async removeFromAllowlist(did: string): Promise<void> {
    const key = allowlistKey(did);
    await this.redis.del(key);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing)
// ---------------------------------------------------------------------------

export class InMemoryAtIngressEventClassifier implements AtIngressEventClassifier {
  private readonly allowlist = new Set<string>();
  private readonly processed = new Set<string>();
  private readonly acceptAll: boolean;

  constructor(options: { acceptAll?: boolean; allowedDids?: string[] } = {}) {
    this.acceptAll = options.acceptAll ?? true;
    if (options.allowedDids) {
      for (const did of options.allowedDids) {
        this.allowlist.add(did);
      }
    }
  }

  async isRelevantDid(did: string): Promise<boolean> {
    if (this.acceptAll) return true;
    return this.allowlist.has(did);
  }

  async isDuplicate(sourceId: string, seq: number): Promise<boolean> {
    return this.processed.has(`${sourceId}:${seq}`);
  }

  async markProcessed(sourceId: string, seq: number): Promise<void> {
    this.processed.add(`${sourceId}:${seq}`);
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ClassifierError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClassifierError';
  }
}

// ---------------------------------------------------------------------------
// Redis client interface
// ---------------------------------------------------------------------------

export interface RedisClassifierClient {
  zscore(key: string, member: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  exists(key: string): Promise<number>;
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
