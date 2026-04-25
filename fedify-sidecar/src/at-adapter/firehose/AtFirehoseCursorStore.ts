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

export interface RedisAtFirehoseCursorStoreOptions {
  keyPrefix?: string;
  maxEvents?: number;
}

type RedisLike = {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(
    key: string,
    min: string,
    max: string,
    limitKeyword: "LIMIT",
    offset: number,
    count: number,
  ): Promise<string[]>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  zcard(key: string): Promise<number>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
};

export class RedisAtFirehoseCursorStore implements AtFirehoseCursorStore {
  private readonly keyPrefix: string;
  private readonly maxEvents: number;

  public constructor(
    private readonly redis: RedisLike,
    options: RedisAtFirehoseCursorStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "at:firehose:cursor-store";
    this.maxEvents = Number.isFinite(options.maxEvents)
      ? Math.max(100, Math.trunc(options.maxEvents!))
      : 10_000;
  }

  public async append(event: FirehoseEventEnvelope): Promise<void> {
    await this.redis.set(this.eventKey(event.seq), JSON.stringify({
      ...event,
      encodedBase64: Buffer.from(event.encoded).toString("base64"),
    }));
    await this.redis.zadd(this.indexKey(), event.seq, String(event.seq));
    await this.redis.set(this.latestSeqKey(), String(event.seq));
    await this.trimOverflow();
  }

  public async readFrom(cursorExclusive: number, limit: number): Promise<FirehoseEventEnvelope[]> {
    if (!Number.isFinite(limit) || limit < 1) {
      return [];
    }

    const members = await this.redis.zrangebyscore(
      this.indexKey(),
      `(${Math.max(-1, Math.trunc(cursorExclusive))}`,
      "+inf",
      "LIMIT",
      0,
      Math.trunc(limit),
    );
    if (members.length === 0) {
      return [];
    }

    const payloads = await this.redis.mget(...members.map((member) => this.eventKey(Number.parseInt(member, 10))));
    const events: FirehoseEventEnvelope[] = [];
    for (const payload of payloads) {
      const event = parseStoredEnvelope(payload);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  public async latestSeq(): Promise<number> {
    const raw = await this.redis.get(this.latestSeqKey());
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    const latest = await this.redis.zrevrange(this.indexKey(), 0, 0);
    if (latest.length === 0) {
      return 0;
    }
    const parsed = Number.parseInt(latest[0] ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private indexKey(): string {
    return `${this.keyPrefix}:index`;
  }

  private latestSeqKey(): string {
    return `${this.keyPrefix}:latest`;
  }

  private eventKey(seq: number): string {
    return `${this.keyPrefix}:event:${seq}`;
  }

  private async trimOverflow(): Promise<void> {
    const total = await this.redis.zcard(this.indexKey());
    const overflow = total - this.maxEvents;
    if (overflow <= 0) {
      return;
    }

    const staleMembers = await this.redis.zrange(this.indexKey(), 0, overflow - 1);
    if (staleMembers.length > 0) {
      await this.redis.del(...staleMembers.map((member) => this.eventKey(Number.parseInt(member, 10))));
    }
    await this.redis.zremrangebyrank(this.indexKey(), 0, overflow - 1);
  }
}

function parseStoredEnvelope(payload: string | null): FirehoseEventEnvelope | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as {
      seq?: unknown;
      type?: unknown;
      emittedAt?: unknown;
      encodedBase64?: unknown;
    };

    if (
      typeof parsed.seq !== "number" ||
      (parsed.type !== "#commit" && parsed.type !== "#identity" && parsed.type !== "#account") ||
      typeof parsed.emittedAt !== "string" ||
      typeof parsed.encodedBase64 !== "string"
    ) {
      return null;
    }

    return {
      seq: parsed.seq,
      type: parsed.type,
      emittedAt: parsed.emittedAt,
      encoded: Uint8Array.from(Buffer.from(parsed.encodedBase64, "base64")),
    };
  } catch {
    return null;
  }
}
