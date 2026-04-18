import type { Redis } from "ioredis";
import { getRegistration, listRegistrations } from "./registry/index.js";
import { withRetry } from "./utils.js";
import type { MRFAdminStore } from "./store.js";
import type {
  MRFChainConfig,
  MRFDecisionTrace,
  MRFModuleConfig,
  MRFModuleManifest,
  MRFSimulationJob,
} from "./types.js";

function safeParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class RedisMRFAdminStore implements MRFAdminStore {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly now: () => string;

  constructor(redis: Redis, options?: { prefix?: string; now?: () => string }) {
    this.redis = redis;
    this.prefix = options?.prefix || "mrf:admin";
    this.now = options?.now || (() => new Date().toISOString());
  }

  private moduleConfigKey(moduleId: string): string {
    return `${this.prefix}:module-config:${moduleId}`;
  }

  private chainConfigKey(): string {
    return `${this.prefix}:chain-config`;
  }

  private traceIndexKey(): string {
    return `${this.prefix}:trace:index`;
  }

  private traceKey(traceId: string): string {
    return `${this.prefix}:trace:${traceId}`;
  }

  private simulationKey(jobId: string): string {
    return `${this.prefix}:simulation:${jobId}`;
  }

  private async withStoreRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { retries: 3, baseMs: 75, maxMs: 1200 });
  }

  async listModuleManifests(): Promise<MRFModuleManifest[]> {
    return listRegistrations().map((registration) => registration.manifest);
  }

  async getModuleManifest(moduleId: string): Promise<MRFModuleManifest | null> {
    return getRegistration(moduleId)?.manifest ?? null;
  }

  async getModuleConfig(moduleId: string): Promise<MRFModuleConfig | null> {
    const raw = await this.withStoreRetry(() => this.redis.get(this.moduleConfigKey(moduleId)));
    return safeParse<MRFModuleConfig>(raw);
  }

  async setModuleConfig(moduleId: string, config: MRFModuleConfig): Promise<void> {
    await this.withStoreRetry(() => this.redis.set(this.moduleConfigKey(moduleId), JSON.stringify(config)));
  }

  async getChainConfig(): Promise<MRFChainConfig> {
    const key = this.chainConfigKey();
    const existing = safeParse<MRFChainConfig>(await this.withStoreRetry(() => this.redis.get(key)));
    if (existing) return existing;

    const fallback: MRFChainConfig = {
      stopOnReject: true,
      defaultTraceVerbosity: "standard",
      modules: listRegistrations()
        .map((registration) => ({
          id: registration.manifest.id,
          priority: registration.manifest.defaultPriority,
          enabled: registration.manifest.defaultMode !== "disabled",
        }))
        .sort((a, b) => a.priority - b.priority),
      updatedAt: this.now(),
      updatedBy: "system",
      revision: 0,
    };

    await this.withStoreRetry(() => this.redis.set(key, JSON.stringify(fallback)));
    return fallback;
  }

  async setChainConfig(config: MRFChainConfig): Promise<void> {
    await this.withStoreRetry(() => this.redis.set(this.chainConfigKey(), JSON.stringify(config)));
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
    const parsedCursor = Number.parseInt(query.cursor || "0", 10);
    const offset = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
    const scanCount = Math.max(query.limit * 5, query.limit);
    const ids = await this.withStoreRetry(() =>
      this.redis.zrevrange(this.traceIndexKey(), offset, offset + scanCount - 1),
    );
    if (ids.length === 0) {
      return { items: [] };
    }

    const traceKeys = ids.map((id) => this.traceKey(id));
    const rawItems = await this.withStoreRetry(() => this.redis.mget(traceKeys));
    const parsed = rawItems
      .map((raw) => safeParse<MRFDecisionTrace>(raw))
      .filter((item): item is MRFDecisionTrace => Boolean(item))
      .filter((trace) => {
        if (query.moduleId && trace.moduleId !== query.moduleId) return false;
        if (query.action && trace.action !== query.action) return false;
        if (query.originHost && trace.originHost !== query.originHost) return false;
        if (query.activityId && trace.activityId !== query.activityId) return false;
        if (query.dateFrom && trace.createdAt < query.dateFrom) return false;
        if (query.dateTo && trace.createdAt > query.dateTo) return false;
        return true;
      })
      .slice(0, query.limit);

    const nextCursor = ids.length >= query.limit ? String(offset + query.limit) : undefined;
    return { items: parsed, nextCursor };
  }

  async getTrace(traceId: string): Promise<MRFDecisionTrace | null> {
    const raw = await this.withStoreRetry(() => this.redis.get(this.traceKey(traceId)));
    return safeParse<MRFDecisionTrace>(raw);
  }

  async appendTrace(trace: MRFDecisionTrace): Promise<void> {
    const createdAtMs = new Date(trace.createdAt).getTime();
    await this.withStoreRetry(async () => {
      const multi = this.redis.multi();
      multi.set(this.traceKey(trace.traceId), JSON.stringify(trace));
      multi.zadd(this.traceIndexKey(), createdAtMs, trace.traceId);
      await multi.exec();
    });
  }

  async createSimulationJob(job: MRFSimulationJob): Promise<void> {
    await this.withStoreRetry(() => this.redis.set(this.simulationKey(job.jobId), JSON.stringify(job)));
  }

  async getSimulationJob(jobId: string): Promise<MRFSimulationJob | null> {
    const raw = await this.withStoreRetry(() => this.redis.get(this.simulationKey(jobId)));
    return safeParse<MRFSimulationJob>(raw);
  }

  async cancelSimulationJob(jobId: string): Promise<void> {
    const current = await this.getSimulationJob(jobId);
    if (!current) return;
    current.status = "cancelled";
    current.updatedAt = this.now();
    await this.createSimulationJob(current);
  }
}
