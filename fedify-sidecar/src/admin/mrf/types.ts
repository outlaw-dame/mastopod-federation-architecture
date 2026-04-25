import type { MRFAdminStore } from "./store.js";
import type { MRFAuditSink } from "./audit.js";

export type MRFMode = "disabled" | "dry-run" | "enforce";
export type MRFAction = "label" | "downrank" | "filter" | "reject";
export type MRFFinalAction = "accept" | MRFAction;

export interface MRFModuleManifest {
  id: string;
  name: string;
  version: string;
  kind: "wasm";
  description?: string;
  allowedActions: MRFAction[];
  defaultMode: MRFMode;
  defaultPriority: number;
  configSchemaVersion: number;
}

export interface MRFModuleConfig {
  enabled: boolean;
  mode: MRFMode;
  priority: number;
  stopOnMatch: boolean;
  config: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
  revision: number;
}

export interface MRFChainConfig {
  stopOnReject: boolean;
  defaultTraceVerbosity: "minimal" | "standard" | "verbose";
  modules: Array<{
    id: string;
    priority: number;
    enabled: boolean;
  }>;
  updatedAt: string;
  updatedBy: string;
  revision: number;
}

export interface MRFDecisionTrace {
  traceId: string;
  requestId: string;
  activityId: string;
  actorId?: string;
  originHost?: string;
  visibility?: "public" | "unlisted" | "followers" | "direct" | "unknown";
  moduleId: string;
  mode: MRFMode;
  action: MRFFinalAction;
  confidence?: number;
  labels?: string[];
  reason?: string;
  createdAt: string;
  redacted: boolean;
  rawContent?: string;
  signedHeaders?: Record<string, unknown>;
  token?: string;
  dmPayload?: unknown;
}

export interface MRFSimulationJob {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  activityId?: string;
  inlinePayloadHash?: string;
  requestedModules?: string[];
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  result?: {
    traces: MRFDecisionTrace[];
    finalAction: MRFFinalAction;
  };
  error?: string;
}

export type MRFPermission = "provider:read" | "provider:write" | "provider:simulate";

export interface MRFAdminDeps {
  adminToken: string;
  store: MRFAdminStore;
  audit: MRFAuditSink;
  now(): string;
  uuid(): string;
  actorFromRequest(req: Request): string;
  sourceIpFromRequest(req: Request): string | undefined;
  authorize(req: Request, permission: MRFPermission): void;
  enqueueSimulation(jobId: string): Promise<void>;
}
