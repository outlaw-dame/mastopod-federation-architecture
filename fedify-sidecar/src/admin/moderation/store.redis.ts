import type { Redis } from "ioredis";
import type {
  AtLabel,
  AtLabelPage,
  AtLabelQuery,
  ModerationBridgeStore,
  ModerationDecision,
  ModerationDecisionPage,
  ModerationDecisionQuery,
} from "./types.js";

// ---------------------------------------------------------------------------
// Redis key layout (all under a configurable prefix)
//
//   {prefix}:decision:{id}          → JSON(ModerationDecision)
//   {prefix}:decision:index         → Sorted Set (score = epoch ms, member = id)
//   {prefix}:label:{seq}            → JSON(AtLabel)   (seq = auto-increment int)
//   {prefix}:label:seq              → integer counter (INCR)
//   {prefix}:label:index            → Sorted Set (score = epoch ms, member = seq)
//   {prefix}:label:by-subject:{uri} → Sorted Set (score = epoch ms, member = seq)
// ---------------------------------------------------------------------------

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class RedisModerationBridgeStore implements ModerationBridgeStore {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly now: () => string;

  constructor(redis: Redis, opts?: { prefix?: string; now?: () => string }) {
    this.redis = redis;
    this.prefix = opts?.prefix ?? "moderation:bridge";
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  // ── Key helpers ──────────────────────────────────────────────────────────

  private decisionKey(id: string): string {
    return `${this.prefix}:decision:${id}`;
  }

  private decisionIndexKey(): string {
    return `${this.prefix}:decision:index`;
  }

  private labelKey(seq: number): string {
    return `${this.prefix}:label:${seq}`;
  }

  private labelSeqKey(): string {
    return `${this.prefix}:label:seq`;
  }

  private labelIndexKey(): string {
    return `${this.prefix}:label:index`;
  }

  private labelSubjectKey(uri: string): string {
    return `${this.prefix}:label:by-subject:${uri}`;
  }

  // ── Decision CRUD ─────────────────────────────────────────────────────────

  async addDecision(decision: ModerationDecision): Promise<void> {
    const key = this.decisionKey(decision.id);
    const existing = await this.redis.get(key);
    if (existing) {
      throw new Error(`Decision ${decision.id} already exists`);
    }

    const score = new Date(decision.appliedAt).getTime();
    const pipeline = this.redis.pipeline();
    pipeline.set(key, JSON.stringify(decision));
    pipeline.zadd(this.decisionIndexKey(), score, decision.id);
    await pipeline.exec();
  }

  async getDecision(id: string): Promise<ModerationDecision | null> {
    const raw = await this.redis.get(this.decisionKey(id));
    return safeParse<ModerationDecision>(raw);
  }

  async listDecisions(query: ModerationDecisionQuery = {}): Promise<ModerationDecisionPage> {
    const { limit = 50, cursor, action, targetAtDid, targetWebId, includeRevoked = true } = query;

    // Walk the index from newest to oldest (rev-range by score)
    let maxScore = "+inf";
    if (cursor) {
      const cursorScore = Number(cursor);
      if (!Number.isNaN(cursorScore)) {
        maxScore = `(${cursorScore}`;
      }
    }

    const candidates = await this.redis.zrevrangebyscore(
      this.decisionIndexKey(),
      maxScore,
      "-inf",
      "LIMIT",
      0,
      // Over-fetch to account for post-filters
      limit * 3,
    );

    const decisions: ModerationDecision[] = [];
    let nextCursor: string | undefined;

    for (const id of candidates) {
      const raw = await this.redis.get(this.decisionKey(id));
      const decision = safeParse<ModerationDecision>(raw);
      if (!decision) continue;

      // Post-filter
      if (!includeRevoked && decision.revoked) continue;
      if (action && decision.action !== action) continue;
      if (targetAtDid && decision.targetAtDid !== targetAtDid) continue;
      if (targetWebId && decision.targetWebId !== targetWebId) continue;

      decisions.push(decision);
      if (decisions.length === limit) {
        const score = await this.redis.zscore(this.decisionIndexKey(), id);
        if (score !== null) nextCursor = score;
        break;
      }
    }

    return { decisions, cursor: nextCursor ?? undefined };
  }

  async patchDecision(id: string, patch: Partial<ModerationDecision>): Promise<ModerationDecision | null> {
    const key = this.decisionKey(id);
    const existing = await this.redis.get(key);
    const decision = safeParse<ModerationDecision>(existing);
    if (!decision) return null;

    const updated: ModerationDecision = { ...decision, ...patch };
    await this.redis.set(key, JSON.stringify(updated));
    return updated;
  }

  // ── AT Label store ────────────────────────────────────────────────────────

  async addAtLabel(label: AtLabel): Promise<void> {
    const seq = await this.redis.incr(this.labelSeqKey());
    const score = new Date(label.cts).getTime();

    const serializable = {
      ...label,
      sig: label.sig instanceof Uint8Array ? Buffer.from(label.sig).toString("base64") : label.sig,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(this.labelKey(seq), JSON.stringify(serializable));
    pipeline.zadd(this.labelIndexKey(), score, String(seq));
    pipeline.zadd(this.labelSubjectKey(label.uri), score, String(seq));
    await pipeline.exec();
  }

  async listAtLabels(query: AtLabelQuery = {}): Promise<AtLabelPage> {
    const { limit = 100, cursor = 0, subject } = query;

    const indexKey = subject ? this.labelSubjectKey(subject) : this.labelIndexKey();

    const seqStrings = await this.redis.zrangebyscore(
      indexKey,
      cursor,
      "+inf",
      "LIMIT",
      0,
      limit,
    );

    const labels: AtLabel[] = [];
    for (const seqStr of seqStrings) {
      const raw = await this.redis.get(this.labelKey(Number(seqStr)));
      const label = safeParse<AtLabel & { sig?: string }>(raw);
      if (!label) continue;

      // Re-materialise sig as base64 string (clients decode as needed)
      labels.push(label as AtLabel);
    }

    const nextCursor =
      seqStrings.length === limit
        ? Number(seqStrings[seqStrings.length - 1]) + 1
        : 0;

    return { labels, cursor: nextCursor };
  }
}
