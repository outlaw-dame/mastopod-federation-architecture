import { getRegistration, listRegistrations } from "./registry/index.js";
import type { MRFAdminStore } from "./store.js";
import type {
  MRFChainConfig,
  MRFDecisionTrace,
  MRFModuleConfig,
  MRFModuleManifest,
  MRFSimulationJob,
} from "./types.js";

export class InMemoryMRFAdminStore implements MRFAdminStore {
  private readonly moduleConfigs = new Map<string, MRFModuleConfig>();
  private chainConfig: MRFChainConfig;
  private readonly traces = new Map<string, MRFDecisionTrace>();
  private readonly traceOrder: string[] = [];
  private readonly simulations = new Map<string, MRFSimulationJob>();

  constructor(now: () => string = () => new Date().toISOString()) {
    this.chainConfig = {
      stopOnReject: true,
      defaultTraceVerbosity: "standard",
      modules: listRegistrations()
        .map((registration) => ({
          id: registration.manifest.id,
          priority: registration.manifest.defaultPriority,
          enabled: registration.manifest.defaultMode !== "disabled",
        }))
        .sort((a, b) => a.priority - b.priority),
      updatedAt: now(),
      updatedBy: "system",
      revision: 0,
    };
  }

  async listModuleManifests(): Promise<MRFModuleManifest[]> {
    return listRegistrations().map((registration) => registration.manifest);
  }

  async getModuleManifest(moduleId: string): Promise<MRFModuleManifest | null> {
    return getRegistration(moduleId)?.manifest ?? null;
  }

  async getModuleConfig(moduleId: string): Promise<MRFModuleConfig | null> {
    return this.moduleConfigs.get(moduleId) ?? null;
  }

  async setModuleConfig(moduleId: string, config: MRFModuleConfig): Promise<void> {
    this.moduleConfigs.set(moduleId, config);
  }

  async getChainConfig(): Promise<MRFChainConfig> {
    return this.chainConfig;
  }

  async setChainConfig(config: MRFChainConfig): Promise<void> {
    this.chainConfig = config;
  }

  async listTraces(query: {
    cursor?: string;
    limit: number;
    moduleId?: string;
    action?: string;
    originHost?: string;
    activityId?: string;
    dateFrom?: string;
    dateTo?: string;
    includePrivate?: boolean;
  }): Promise<{ items: MRFDecisionTrace[]; nextCursor?: string }> {
    const offset = Number.parseInt(query.cursor || "0", 10) || 0;
    const ordered = this.traceOrder
      .map((id) => this.traces.get(id))
      .filter((item): item is MRFDecisionTrace => Boolean(item))
      .filter((trace) => {
        if (query.moduleId && trace.moduleId !== query.moduleId) return false;
        if (query.action && trace.action !== query.action) return false;
        if (query.originHost && trace.originHost !== query.originHost) return false;
        if (query.activityId && trace.activityId !== query.activityId) return false;
        if (query.dateFrom && trace.createdAt < query.dateFrom) return false;
        if (query.dateTo && trace.createdAt > query.dateTo) return false;
        return true;
      });

    const items = ordered.slice(offset, offset + query.limit);
    const nextOffset = offset + query.limit;
    return {
      items,
      nextCursor: nextOffset < ordered.length ? String(nextOffset) : undefined,
    };
  }

  async getTrace(traceId: string): Promise<MRFDecisionTrace | null> {
    return this.traces.get(traceId) ?? null;
  }

  async createSimulationJob(job: MRFSimulationJob): Promise<void> {
    this.simulations.set(job.jobId, job);
  }

  async getSimulationJob(jobId: string): Promise<MRFSimulationJob | null> {
    return this.simulations.get(jobId) ?? null;
  }

  async cancelSimulationJob(jobId: string): Promise<void> {
    const current = this.simulations.get(jobId);
    if (!current) return;
    this.simulations.set(jobId, {
      ...current,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    });
  }
}
