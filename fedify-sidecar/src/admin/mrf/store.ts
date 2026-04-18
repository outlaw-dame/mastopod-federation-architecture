import type {
  MRFChainConfig,
  MRFDecisionTrace,
  MRFModuleConfig,
  MRFModuleManifest,
  MRFSimulationJob,
} from "./types.js";

export interface MRFAdminStore {
  listModuleManifests(): Promise<MRFModuleManifest[]>;
  getModuleManifest(moduleId: string): Promise<MRFModuleManifest | null>;

  getModuleConfig(moduleId: string): Promise<MRFModuleConfig | null>;
  setModuleConfig(moduleId: string, config: MRFModuleConfig): Promise<void>;

  getChainConfig(): Promise<MRFChainConfig>;
  setChainConfig(config: MRFChainConfig): Promise<void>;

  listTraces(query: {
    cursor?: string;
    limit: number;
    moduleId?: string;
    action?: string;
    originHost?: string;
    activityId?: string;
    dateFrom?: string;
    dateTo?: string;
    includePrivate?: boolean;
  }): Promise<{ items: MRFDecisionTrace[]; nextCursor?: string }>;

  getTrace(traceId: string): Promise<MRFDecisionTrace | null>;
  appendTrace(trace: MRFDecisionTrace): Promise<void>;

  createSimulationJob(job: MRFSimulationJob): Promise<void>;
  getSimulationJob(jobId: string): Promise<MRFSimulationJob | null>;
  cancelSimulationJob?(jobId: string): Promise<void>;
}
