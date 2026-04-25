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

const MAX_IN_MEMORY_DECISIONS = 5_000;
const MAX_IN_MEMORY_CASES = 5_000;
const MAX_IN_MEMORY_LABELS = 10_000;

export class InMemoryModerationBridgeStore implements ModerationBridgeStore {
  private decisions = new Map<string, ModerationDecision>();
  private decisionOrder: string[] = []; // newest-first ids
  private cases = new Map<string, ModerationCase>();
  private caseOrder: string[] = []; // newest-first ids
  private caseDedupes = new Map<string, string>();
  private labels: AtLabel[] = [];

  async addDecision(decision: ModerationDecision): Promise<void> {
    if (this.decisions.has(decision.id)) {
      throw new Error(`Decision ${decision.id} already exists`);
    }
    this.decisions.set(decision.id, decision);
    this.decisionOrder.unshift(decision.id);
    if (this.decisionOrder.length > MAX_IN_MEMORY_DECISIONS) {
      const evictedId = this.decisionOrder.pop();
      if (evictedId) this.decisions.delete(evictedId);
    }
  }

  async getDecision(id: string): Promise<ModerationDecision | null> {
    return this.decisions.get(id) ?? null;
  }

  async listDecisions(query: ModerationDecisionQuery = {}): Promise<ModerationDecisionPage> {
    const {
      limit = 50,
      cursor,
      action,
      targetAtDid,
      targetWebId,
      targetActorUri,
      includeRevoked = true,
    } = query;

    let start = 0;
    if (cursor) {
      const i = this.decisionOrder.findIndex((id) => id === cursor);
      start = i >= 0 ? i + 1 : 0;
    }

    const out: ModerationDecision[] = [];
    let nextCursor: string | undefined;

    for (let i = start; i < this.decisionOrder.length; i += 1) {
      const id = this.decisionOrder[i];
      if (!id) continue;
      const decision = this.decisions.get(id);
      if (!decision) continue;

      if (!includeRevoked && decision.revoked) continue;
      if (action && decision.action !== action) continue;
      if (targetAtDid && decision.targetAtDid !== targetAtDid) continue;
      if (targetWebId && decision.targetWebId !== targetWebId) continue;
      if (targetActorUri && decision.targetActorUri !== targetActorUri) continue;

      out.push(decision);
      if (out.length >= limit) {
        nextCursor = id;
        break;
      }
    }

    return { decisions: out, cursor: nextCursor };
  }

  async patchDecision(id: string, patch: Partial<ModerationDecision>): Promise<ModerationDecision | null> {
    const existing = this.decisions.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.decisions.set(id, updated);
    return updated;
  }

  async addCase(entry: ModerationCase): Promise<void> {
    if (this.cases.has(entry.id)) {
      throw new Error(`Case ${entry.id} already exists`);
    }
    this.cases.set(entry.id, entry);
    this.caseOrder.unshift(entry.id);
    this.caseDedupes.set(entry.dedupeKey, entry.id);
    if (this.caseOrder.length > MAX_IN_MEMORY_CASES) {
      const evictedId = this.caseOrder.pop();
      if (evictedId) {
        const evicted = this.cases.get(evictedId);
        if (evicted) {
          this.caseDedupes.delete(evicted.dedupeKey);
        }
        this.cases.delete(evictedId);
      }
    }
  }

  async getCase(id: string): Promise<ModerationCase | null> {
    return this.cases.get(id) ?? null;
  }

  async findCaseByDedupeKey(dedupeKey: string): Promise<ModerationCase | null> {
    const id = this.caseDedupes.get(dedupeKey);
    return id ? this.cases.get(id) ?? null : null;
  }

  async listCases(query: ModerationCaseQuery = {}): Promise<ModerationCasePage> {
    const {
      limit = 50,
      cursor,
      status,
      source,
      sourceActorUri,
      recipientWebId,
      reportedActorUri,
    } = query;

    let start = 0;
    if (cursor) {
      const i = this.caseOrder.findIndex((id) => id === cursor);
      start = i >= 0 ? i + 1 : 0;
    }

    const out: ModerationCase[] = [];
    let nextCursor: string | undefined;

    for (let i = start; i < this.caseOrder.length; i += 1) {
      const id = this.caseOrder[i];
      if (!id) continue;
      const entry = this.cases.get(id);
      if (!entry) continue;

      if (status && entry.status !== status) continue;
      if (source && entry.source !== source) continue;
      if (sourceActorUri && entry.reporter?.activityPubActorUri !== sourceActorUri) continue;
      if (recipientWebId && entry.recipient?.webId !== recipientWebId) continue;
      if (reportedActorUri && !caseMatchesReportedActor(entry, reportedActorUri)) continue;

      out.push(entry);
      if (out.length >= limit) {
        nextCursor = id;
        break;
      }
    }

    return { cases: out, cursor: nextCursor };
  }

  async patchCase(id: string, patch: Partial<ModerationCase>): Promise<ModerationCase | null> {
    const existing = this.cases.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.cases.set(id, updated);
    if (updated.dedupeKey !== existing.dedupeKey) {
      this.caseDedupes.delete(existing.dedupeKey);
      this.caseDedupes.set(updated.dedupeKey, id);
    }
    return updated;
  }

  async addAtLabel(label: AtLabel): Promise<void> {
    this.labels.push(label);
    if (this.labels.length > MAX_IN_MEMORY_LABELS) {
      this.labels.splice(0, this.labels.length - MAX_IN_MEMORY_LABELS);
    }
  }

  async listAtLabels(query: AtLabelQuery = {}): Promise<AtLabelPage> {
    const { limit = 100, cursor = 0, subject } = query;
    const filtered = subject ? this.labels.filter((l) => l.uri === subject) : this.labels;
    const start = Math.max(0, cursor);
    const labels = filtered.slice(start, start + limit);
    const next = start + limit < filtered.length ? start + limit : 0;
    return { labels, cursor: next };
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
