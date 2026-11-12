/**
 * Redis atomic single-writer lease and source-scoped cursor fence.
 * Redis replication/persistence are asynchronous: production must separately
 * prove durability and deduplication under failover.
 */
import { createHash, randomUUID } from "node:crypto";
import { withRedisFenceDeadline } from "./RedisFenceDeadline.js";

export interface FirehoseFenceRedis {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** The legacy namespace is probed before changing the fence key layout. */
  get(key: string): Promise<string | null>;
}
export interface FirehoseLease { token: string }
export interface FirehoseSourceFence {
  tryAcquire(sourceId: string): Promise<FirehoseLease | null>;
  renew(sourceId: string, lease: FirehoseLease): Promise<boolean>;
  release(sourceId: string, lease: FirehoseLease): Promise<void>;
  getResumeCursor(sourceId: string, lease: FirehoseLease): Promise<number | null>;
  markAcknowledged(sourceId: string, lease: FirehoseLease, seq: number): Promise<void>;
  commit(sourceId: string, lease: FirehoseLease, seq: number): Promise<void>;
}
export class FirehoseFenceError extends Error {
  constructor(message: string) { super(message); this.name = "FirehoseFenceError"; }
}

const ACQUIRE = [
  "if redis.call('EXISTS', KEYS[1]) ~= 0 then return '' end",
  "local epoch = redis.call('INCR', KEYS[2])",
  "local owner = ARGV[1] .. ':' .. tostring(epoch)",
  "redis.call('SET', KEYS[1], owner, 'PX', ARGV[2])",
  "return owner",
].join("\n");
const RENEW = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "return redis.call('PEXPIRE', KEYS[1], ARGV[2])",
].join("\n");
const RELEASE = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "return redis.call('DEL', KEYS[1])",
].join("\n");
const READ = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {-1} end",
  "return {redis.call('GET', KEYS[2]) or '', redis.call('GET', KEYS[3]) or ''}",
].join("\n");
const NOTE_ACK = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end",
  "local prev = redis.call('GET', KEYS[2])",
  "local next = ARGV[2]",
  // Inclusive relay replay is expected. Never move the hot cursor backward,
  // but do not reject a harmless duplicate after the broker acknowledged it.
  "if prev and (#prev > #next or (#prev == #next and prev >= next)) then return 1 end",
  "if not prev or prev ~= next then redis.call('SET', KEYS[2], next) end",
  "return 1",
].join("\n");
const COMMIT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end",
  "local hot = redis.call('GET', KEYS[2])",
  "local next = ARGV[2]",
  "if not hot or #hot < #next or (#hot == #next and hot < next) then return -2 end",
  "local old = redis.call('GET', KEYS[3])",
  "if old and (#old > #next or (#old == #next and old > next)) then return -3 end",
  "if not old or old ~= next then redis.call('SET', KEYS[3], next) end",
  "return 1",
].join("\n");

function sourceDigest(sourceId: string): string {
  if (!sourceId || sourceId.length > 2048) {
    throw new FirehoseFenceError("Invalid external Sync source identifier");
  }
  return createHash("sha256").update(sourceId).digest("hex").slice(0, 40);
}

/** Multi-key Lua scripts require all keys in one Redis Cluster hash slot. */
export function externalSyncFenceKeys(sourceId: string) {
  const digest = sourceDigest(sourceId);
  // The per-source tag spreads different sources across slots while putting
  // owner, epoch, hot and committed keys for one source on the same shard.
  const base = "at:external-sync:v2:{" + digest + "}";
  return {
    owner: base + ":owner", epoch: base + ":epoch",
    hot: base + ":hot", committed: base + ":committed",
  };
}

function legacyFenceKeys(sourceId: string) {
  const base = "at:external-sync:v1:" + sourceDigest(sourceId);
  return { owner: base + ":owner", hot: base + ":hot",
    committed: base + ":committed" };
}

function canonicalSeq(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new FirehoseFenceError("External firehose checkpoint is not canonical decimal");
  }
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new FirehoseFenceError("External firehose checkpoint exceeds safe integer bounds");
  }
  return seq;
}
function validSeq(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new FirehoseFenceError("External firehose cursor must be a safe nonnegative integer");
  }
  return String(seq);
}

/** Atomic within one Redis primary; no guarantee across divergent Redis clusters. */
export class RedisAtFirehoseSourceFence implements FirehoseSourceFence {
  public readonly leaseTtlMs: number;

  constructor(private readonly redis: FirehoseFenceRedis, leaseTtlMs = 15000) {
    if (!Number.isSafeInteger(leaseTtlMs) ||
        leaseTtlMs < 500 || leaseTtlMs > 120000) {
      throw new FirehoseFenceError("Lease TTL must be between 500ms and 120s");
    }
    this.leaseTtlMs = leaseTtlMs;
  }

  private evalGuarded(script: string, count: number,
    ...args: (string | number)[]): Promise<unknown> {
    const timeoutMs = Math.max(200, Math.min(4000, Math.floor(this.leaseTtlMs / 3)));
    return withRedisFenceDeadline(
      this.redis.eval(script, count, ...args), timeoutMs,
    );
  }

  async tryAcquire(sourceId: string): Promise<FirehoseLease | null> {
    // Existing v1 checkpoints must not be silently abandoned when enabling
    // Cluster-compatible v2 keys. This check intentionally fails closed until
    // an operator drains old writers and migrates the replay checkpoint.
    const legacy = legacyFenceKeys(sourceId);
    const old = await Promise.all([
      this.redis.get(legacy.owner),
      this.redis.get(legacy.hot),
      this.redis.get(legacy.committed),
    ]);
    if (old.some(value => value !== null)) {
      throw new FirehoseFenceError(
        "Legacy external Sync checkpoint/lease exists; drain and migrate before v2",
      );
    }
    const k = externalSyncFenceKeys(sourceId);
    const token = randomUUID();
    const value = await this.evalGuarded(ACQUIRE, 2, k.owner, k.epoch,
      token, String(this.leaseTtlMs));
    if (value === "") return null;
    if (typeof value !== "string" || !value.startsWith(token + ":")) {
      throw new FirehoseFenceError("Unexpected lease acquisition result");
    }
    return { token: value };
  }

  async renew(sourceId: string, lease: FirehoseLease): Promise<boolean> {
    const k = externalSyncFenceKeys(sourceId);
    const result = await this.evalGuarded(RENEW, 1, k.owner, lease.token,
      String(this.leaseTtlMs));
    if (result !== 0 && result !== 1) {
      throw new FirehoseFenceError("Unexpected lease renewal result");
    }
    return result === 1;
  }

  async release(sourceId: string, lease: FirehoseLease): Promise<void> {
    const k = externalSyncFenceKeys(sourceId);
    await this.evalGuarded(RELEASE, 1, k.owner, lease.token);
  }

  async getResumeCursor(sourceId: string, lease: FirehoseLease): Promise<number | null> {
    const k = externalSyncFenceKeys(sourceId);
    const result = await this.evalGuarded(READ, 3, k.owner, k.committed, k.hot,
      lease.token);
    if (!Array.isArray(result) || result.length < 1) {
      throw new FirehoseFenceError("Invalid lease checkpoint response");
    }
    if (result[0] === -1) throw new FirehoseFenceError("Firehose source ownership lost");
    if (result.length !== 2) throw new FirehoseFenceError("Invalid cursor response length");
    // Committed is replay-safe; hot is used only on the first-ever checkpoint.
    return canonicalSeq(result[0]) ?? canonicalSeq(result[1]);
  }

  async markAcknowledged(sourceId: string, lease: FirehoseLease, seq: number): Promise<void> {
    const k = externalSyncFenceKeys(sourceId);
    const result = await this.evalGuarded(NOTE_ACK, 2, k.owner, k.hot,
      lease.token, validSeq(seq));
    if (result !== 1) {
      throw new FirehoseFenceError(result === -1
        ? "Firehose lease expired before broker acknowledgment"
        : "Firehose acknowledged cursor would regress");
    }
  }

  async commit(sourceId: string, lease: FirehoseLease, seq: number): Promise<void> {
    const k = externalSyncFenceKeys(sourceId);
    const result = await this.evalGuarded(COMMIT, 3,
      k.owner, k.hot, k.committed, lease.token, validSeq(seq));
    if (result !== 1) {
      throw new FirehoseFenceError(result === -1
        ? "Firehose lease expired before checkpoint"
        : "Firehose checkpoint is not acknowledged or would regress");
    }
  }
}
