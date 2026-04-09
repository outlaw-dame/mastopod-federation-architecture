import type {
  AtLabel,
  AtLabelPage,
  AtLabelQuery,
  ModerationBridgeStore,
  ModerationDecision,
  ModerationDecisionPage,
  ModerationDecisionQuery,
} from "./types.js";

export class InMemoryModerationBridgeStore implements ModerationBridgeStore {
  private decisions = new Map<string, ModerationDecision>();
  private decisionOrder: string[] = []; // newest-first ids
  private labels: AtLabel[] = [];

  async addDecision(decision: ModerationDecision): Promise<void> {
    if (this.decisions.has(decision.id)) {
      throw new Error(`Decision ${decision.id} already exists`);
    }
    this.decisions.set(decision.id, decision);
    this.decisionOrder.unshift(decision.id);
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

  async addAtLabel(label: AtLabel): Promise<void> {
    this.labels.push(label);
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
