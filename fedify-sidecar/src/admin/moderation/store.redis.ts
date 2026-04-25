import type { Redis } from "ioredis";
import { createHash } from "node:crypto";
import type {
  AtLabel,
  AtLabelPage,
  AtLabelQuery,
  ModerationBridgeStore,
  ModerationCase,
  ModerationCasePage,
  ModerationCaseQuery,
  ModerationDecision,
  ModerationDecisionPage,
  ModerationDecisionQuery,
} from "./types.js";

// ---------------------------------------------------------------------------
// Redis key layout (all under a configurable prefix)
//
//   {prefix}:decision:{id}          → JSON(ModerationDecision)
//   {prefix}:decision:index         → Sorted Set (score = epoch ms, member = id)
//   {prefix}:case:{id}              → JSON(ModerationCase)
//   {prefix}:case:index             → Sorted Set (score = epoch ms, member = id)
//   {prefix}:case:dedupe:{sha256}   → id
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

  private caseKey(id: string): string {
    return `${this.prefix}:case:${id}`;
  }

  private caseIndexKey(): string {
    return `${this.prefix}:case:index`;
  }

  private caseDedupeKey(dedupeKey: string): string {
    const digest = createHash("sha256").update(dedupeKey).digest("hex");
    return `${this.prefix}:case:dedupe:${digest}`;
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
    const { limit = 50, cursor, action, targetAtDid, targetWebId, targetActorUri, includeRevoked = true } = query;

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
      if (targetActorUri && decision.targetActorUri !== targetActorUri) continue;

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

  // ── Moderation case store ─────────────────────────────────────────────────

  async addCase(entry: ModerationCase): Promise<void> {
    const key = this.caseKey(entry.id);
    const existing = await this.redis.get(key);
    if (existing) {
      throw new Error(`Case ${entry.id} already exists`);
    }

    const score = new Date(entry.receivedAt).getTime();
    const pipeline = this.redis.pipeline();
    pipeline.set(key, JSON.stringify(entry));
    pipeline.zadd(this.caseIndexKey(), score, entry.id);
    pipeline.set(this.caseDedupeKey(entry.dedupeKey), entry.id);
    await pipeline.exec();
  }

  async getCase(id: string): Promise<ModerationCase | null> {
    const raw = await this.redis.get(this.caseKey(id));
    return safeParse<ModerationCase>(raw);
  }

  async findCaseByDedupeKey(dedupeKey: string): Promise<ModerationCase | null> {
    const id = await this.redis.get(this.caseDedupeKey(dedupeKey));
    if (!id) return null;
    return this.getCase(id);
  }

  async listCases(query: ModerationCaseQuery = {}): Promise<ModerationCasePage> {
    const { limit = 50, cursor, status, source, sourceActorUri, recipientWebId, reportedActorUri } = query;

    let maxScore = "+inf";
    if (cursor) {
      const cursorScore = Number(cursor);
      if (!Number.isNaN(cursorScore)) {
        maxScore = `(${cursorScore}`;
      }
    }

    const candidates = await this.redis.zrevrangebyscore(
      this.caseIndexKey(),
      maxScore,
      "-inf",
      "LIMIT",
      0,
      limit * 3,
    );

    const cases: ModerationCase[] = [];
    let nextCursor: string | undefined;

    for (const id of candidates) {
      const raw = await this.redis.get(this.caseKey(id));
      const entry = safeParse<ModerationCase>(raw);
      if (!entry) continue;

      if (status && entry.status !== status) continue;
      if (source && entry.source !== source) continue;
      if (sourceActorUri && entry.reporter?.activityPubActorUri !== sourceActorUri) continue;
      if (recipientWebId && entry.recipient?.webId !== recipientWebId) continue;
      if (reportedActorUri && !caseMatchesReportedActor(entry, reportedActorUri)) continue;

      cases.push(entry);
      if (cases.length === limit) {
        const score = await this.redis.zscore(this.caseIndexKey(), id);
        if (score !== null) nextCursor = score;
        break;
      }
    }

    return { cases, cursor: nextCursor ?? undefined };
  }

  async patchCase(id: string, patch: Partial<ModerationCase>): Promise<ModerationCase | null> {
    const key = this.caseKey(id);
    const existing = await this.redis.get(key);
    const entry = safeParse<ModerationCase>(existing);
    if (!entry) return null;

    const updated: ModerationCase = { ...entry, ...patch };
    const pipeline = this.redis.pipeline();
    pipeline.set(key, JSON.stringify(updated));
    if (updated.dedupeKey !== entry.dedupeKey) {
      pipeline.del(this.caseDedupeKey(entry.dedupeKey));
      pipeline.set(this.caseDedupeKey(updated.dedupeKey), id);
    }
    await pipeline.exec();
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
    const start = Math.max(0, Number.isFinite(cursor) ? Math.trunc(cursor) : 0);
    const seqStrings = await this.redis.zrange(indexKey, start, start + limit - 1);

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
        ? start + limit
        : 0;

    return { labels, cursor: nextCursor };
  }
}

function caseMatchesReportedActor(entry: ModerationCase, actorUri: string): boolean {
  if (entry.subject.kind === "account" && entry.subject.actor.activityPubActorUri === actorUri) {
    return true;
  }

  if (entry.subject.kind === "object" && entry.subject.owner?.activityPubActorUri === actorUri) {
    return true;
  }

  return false;
}
