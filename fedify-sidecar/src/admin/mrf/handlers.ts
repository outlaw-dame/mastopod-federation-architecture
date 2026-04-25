import {
  listTracesQuerySchema,
  patchChainSchema,
  patchModuleSchema,
  simulateSchema,
} from "./schemas.js";
import { assertAdminBearer } from "./auth.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { json, parseJson, parseWithSchema, redactTrace } from "./utils.js";
import { buildRegistryDescriptor, redactSecretFields } from "./registry/descriptor.js";
import { getRegistration, listRegistrations } from "./registry/index.js";
import type { MRFAdminDeps } from "./types.js";

type TraceSuggestion = {
  field: string;
  type: "increase" | "decrease" | "toggle" | "add" | "remove";
  suggestedValue: unknown;
  rationale: string;
};

type MetricsAccumulator = {
  decisions: number;
  byAction: Record<string, number>;
  byModule: Record<string, number>;
  byMode: Record<string, number>;
};

function parseQuery(url: string): Record<string, string> {
  const u = new URL(url);
  return Object.fromEntries(u.searchParams.entries());
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toIsoDateOrThrow(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`Invalid ${name} date`);
  }
  return date.toISOString();
}

function byCreatedAtAsc<T extends { createdAt: string }>(a: T, b: T): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function generateTraceSuggestions(trace: {
  moduleId: string;
  action: string;
  confidence?: number;
}): TraceSuggestion[] {
  const suggestions: TraceSuggestion[] = [];
  const confidence = trace.confidence ?? 0;

  if (trace.moduleId === "trust-eval") {
    if (trace.action === "label" && confidence > 0.4) {
      suggestions.push({
        field: "thresholdLabel",
        type: "increase",
        suggestedValue: clamp01(confidence + 0.05),
        rationale: "Label action triggered at comparatively low confidence.",
      });
    }

    if (trace.action === "reject" && confidence < 0.85) {
      suggestions.push({
        field: "thresholdReject",
        type: "increase",
        suggestedValue: 0.9,
        rationale: "Reject action occurred below a conservative confidence threshold.",
      });
    }

    if (trace.action === "downrank" && confidence < 0.3) {
      suggestions.push({
        field: "thresholdDownrank",
        type: "increase",
        suggestedValue: 0.4,
        rationale: "Downrank triggered at low confidence; consider reducing sensitivity.",
      });
    }
  }

  return suggestions;
}

export async function handleListModules(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const manifests = await deps.store.listModuleManifests();
  const items = await Promise.all(
    manifests.map(async (manifest) => {
      const registration = getRegistration(manifest.id);
      const config = await deps.store.getModuleConfig(manifest.id);
      if (!config) {
        return { manifest, config: null };
      }

      return {
        manifest,
        config: {
          ...config,
          config: redactSecretFields(registration, config.config),
        },
      };
    }),
  );

  return json({ data: items });
}

export async function handleListRegistry(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const items = listRegistrations().map((registration) => buildRegistryDescriptor(registration));
  return json({ data: items });
}

export async function handleGetRegistryItem(
  req: Request,
  deps: MRFAdminDeps,
  moduleId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const registration = getRegistration(moduleId);
  if (!registration) throw notFound("MRF module registry item not found");

  return json({ data: buildRegistryDescriptor(registration) });
}

export async function handleGetModule(
  req: Request,
  deps: MRFAdminDeps,
  moduleId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const manifest = await deps.store.getModuleManifest(moduleId);
  if (!manifest) throw notFound("MRF module not found");

  const registration = getRegistration(moduleId);
  const config = await deps.store.getModuleConfig(moduleId);
  const safeConfig = config
    ? {
        ...config,
        config: redactSecretFields(registration, config.config),
      }
    : null;

  return json({ data: { manifest, config: safeConfig } });
}

export async function handlePatchModule(
  req: Request,
  deps: MRFAdminDeps,
  moduleId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:write");

  const actor = deps.actorFromRequest(req);
  const requestId = req.headers.get("x-request-id") || deps.uuid();

  const manifest = await deps.store.getModuleManifest(moduleId);
  if (!manifest) throw notFound("MRF module not found");

  const body = parseWithSchema(patchModuleSchema, await parseJson(req));
  const current = await deps.store.getModuleConfig(moduleId);
  if (!current) throw notFound("MRF module config not found");

  if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) {
    throw conflict("MRF module config revision mismatch");
  }

  const registration = getRegistration(moduleId);
  if (!registration) {
    throw notFound("MRF module registration not found");
  }

  const rawPatch = body.config || {};

  let normalized;
  try {
    normalized = registration.validateAndNormalizeConfig(rawPatch, {
      partial: true,
      existingConfig: current.config,
    });
  } catch (err) {
    throw badRequest((err as Error)?.message || "Invalid module config patch");
  }

  const next = {
    ...current,
    ...body,
    config: normalized.config,
    updatedAt: deps.now(),
    updatedBy: actor,
    revision: current.revision + 1,
  };

  if (registration.validateMode) {
    try {
      registration.validateMode(next.mode, next.config);
    } catch (err) {
      throw badRequest((err as Error)?.message || "Invalid module mode for config");
    }
  }

  await deps.store.setModuleConfig(moduleId, next);

  await deps.audit.log({
    type: "module.patch",
    actor,
    requestId,
    sourceIp: deps.sourceIpFromRequest(req),
    target: moduleId,
    before: {
      ...current,
      config: redactSecretFields(registration, current.config, "[REDACTED]"),
    },
    after: {
      ...next,
      config: redactSecretFields(registration, next.config, "[REDACTED]"),
    },
    createdAt: deps.now(),
  });

  return json({
    data: {
      ...next,
      config: redactSecretFields(registration, next.config),
    },
    warnings: normalized.warnings || [],
  });
}

export async function handleGetChain(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const chain = await deps.store.getChainConfig();
  return json({ data: chain });
}

export async function handlePatchChain(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:write");

  const actor = deps.actorFromRequest(req);
  const requestId = req.headers.get("x-request-id") || deps.uuid();

  const body = parseWithSchema(patchChainSchema, await parseJson(req));
  const current = await deps.store.getChainConfig();

  if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) {
    throw conflict("MRF chain revision mismatch");
  }

  if (body.modules) {
    const known = new Set((await deps.store.listModuleManifests()).map(m => m.id));
    for (const m of body.modules) {
      if (!known.has(m.id)) {
        throw badRequest(`Unknown module id in chain: ${m.id}`);
      }
    }
  }

  const next = {
    ...current,
    ...body,
    updatedAt: deps.now(),
    updatedBy: actor,
    revision: current.revision + 1,
  };

  await deps.store.setChainConfig(next);

  await deps.audit.log({
    type: "chain.patch",
    actor,
    requestId,
    sourceIp: deps.sourceIpFromRequest(req),
    target: "mrf-chain",
    before: current,
    after: next,
    createdAt: deps.now(),
  });

  return json({ data: next });
}

export async function handleListTraces(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const query = listTracesQuerySchema.parse(parseQuery(req.url));
  const result = await deps.store.listTraces(query);

  return json({
    data: result.items.map(item => redactTrace(item, query.includePrivate)),
    nextCursor: result.nextCursor,
  });
}

export async function handleGetTrace(
  req: Request,
  deps: MRFAdminDeps,
  traceId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const includePrivate = new URL(req.url).searchParams.get("includePrivate") === "true";
  const trace = await deps.store.getTrace(traceId);
  if (!trace) throw notFound("MRF trace not found");

  return json({ data: redactTrace(trace, includePrivate) });
}

export async function handleGetTraceDecisionChain(
  req: Request,
  deps: MRFAdminDeps,
  traceId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const includePrivate = new URL(req.url).searchParams.get("includePrivate") === "true";
  const trace = await deps.store.getTrace(traceId);
  if (!trace) throw notFound("MRF trace not found");

  let steps = [trace];

  if (trace.activityId && trace.requestId) {
    const result = await deps.store.listTraces({
      limit: 100,
      activityId: trace.activityId,
      includePrivate: true,
    });

    const related = result.items.filter(
      item => item.activityId === trace.activityId && item.requestId === trace.requestId,
    );

    if (related.length > 0) {
      steps = related.sort(byCreatedAtAsc);
    }
  }

  const safeSteps = steps.map(step => redactTrace(step, includePrivate));
  const finalStep = safeSteps[safeSteps.length - 1] as { action?: string } | undefined;

  return json({
    data: {
      traceId,
      requestId: trace.requestId,
      activityId: trace.activityId,
      moduleId: trace.moduleId,
      createdAt: trace.createdAt,
      finalAction: finalStep?.action ?? trace.action,
      steps: safeSteps,
    },
  });
}

export async function handleGetTraceSuggestions(
  req: Request,
  deps: MRFAdminDeps,
  traceId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const trace = await deps.store.getTrace(traceId);
  if (!trace) throw notFound("MRF trace not found");

  const suggestions = generateTraceSuggestions(trace);

  return json({
    data: {
      moduleId: trace.moduleId,
      traceId,
      activityId: trace.activityId,
      signals: {
        action: trace.action,
        confidence: trace.confidence,
        labels: trace.labels,
        reason: trace.reason,
      },
      suggestions,
    },
  });
}

export async function handleGetMetrics(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:read");

  const url = new URL(req.url);
  const dateFrom = toIsoDateOrThrow(url.searchParams.get("from"), "from");
  const dateTo = toIsoDateOrThrow(url.searchParams.get("to"), "to");
  const moduleId = url.searchParams.get("moduleId") || undefined;
  const action = url.searchParams.get("action") || undefined;
  const originHost = url.searchParams.get("originHost") || undefined;

  const requestedLimit = Number(url.searchParams.get("maxItems") || "1000");
  const maxItems = Number.isFinite(requestedLimit)
    ? Math.max(100, Math.min(5000, Math.floor(requestedLimit)))
    : 1000;

  const totals: MetricsAccumulator = {
    decisions: 0,
    byAction: {},
    byModule: {},
    byMode: {},
  };

  const confidenceBuckets = [
    { min: 0, max: 0.25, count: 0 },
    { min: 0.25, max: 0.5, count: 0 },
    { min: 0.5, max: 0.75, count: 0 },
    { min: 0.75, max: 1.01, count: 0 },
  ];

  const domains = new Map<string, { host: string; decisions: number; rejects: number; filters: number }>();
  const modules = new Map<string, { id: string; decisions: number; rejectCount: number; confidenceTotal: number; confidenceCount: number }>();
  const thresholdPressure = {
    nearMidpointCount: 0,
    nearRejectBoundaryCount: 0,
  };

  let cursor: string | undefined;
  let fetched = 0;

  while (fetched < maxItems) {
    const page = await deps.store.listTraces({
      cursor,
      limit: Math.min(100, maxItems - fetched),
      moduleId,
      action: action as "accept" | "label" | "downrank" | "filter" | "reject" | undefined,
      originHost,
      dateFrom,
      dateTo,
      includePrivate: false,
    });

    for (const trace of page.items) {
      fetched += 1;
      totals.decisions += 1;
      totals.byAction[trace.action] = (totals.byAction[trace.action] || 0) + 1;
      totals.byModule[trace.moduleId] = (totals.byModule[trace.moduleId] || 0) + 1;
      totals.byMode[trace.mode] = (totals.byMode[trace.mode] || 0) + 1;

      const host = trace.originHost || "(unknown)";
      const domainStats = domains.get(host) || { host, decisions: 0, rejects: 0, filters: 0 };
      domainStats.decisions += 1;
      if (trace.action === "reject") domainStats.rejects += 1;
      if (trace.action === "filter") domainStats.filters += 1;
      domains.set(host, domainStats);

      const moduleStats = modules.get(trace.moduleId) || {
        id: trace.moduleId,
        decisions: 0,
        rejectCount: 0,
        confidenceTotal: 0,
        confidenceCount: 0,
      };
      moduleStats.decisions += 1;
      if (trace.action === "reject") moduleStats.rejectCount += 1;
      if (typeof trace.confidence === "number") {
        moduleStats.confidenceTotal += trace.confidence;
        moduleStats.confidenceCount += 1;

        if (trace.confidence >= 0.45 && trace.confidence <= 0.55) {
          thresholdPressure.nearMidpointCount += 1;
        }
        if (trace.confidence >= 0.8 && trace.confidence <= 0.9) {
          thresholdPressure.nearRejectBoundaryCount += 1;
        }

        for (const bucket of confidenceBuckets) {
          if (trace.confidence >= bucket.min && trace.confidence < bucket.max) {
            bucket.count += 1;
            break;
          }
        }
      }
      modules.set(trace.moduleId, moduleStats);

      if (fetched >= maxItems) break;
    }

    if (!page.nextCursor || fetched >= maxItems) {
      break;
    }

    cursor = page.nextCursor;
  }

  const moduleRows = [...modules.values()]
    .map(m => ({
      id: m.id,
      decisions: m.decisions,
      rejectRate: m.decisions > 0 ? m.rejectCount / m.decisions : 0,
      avgConfidence: m.confidenceCount > 0 ? m.confidenceTotal / m.confidenceCount : 0,
    }))
    .sort((a, b) => b.decisions - a.decisions);

  const domainRows = [...domains.values()].sort((a, b) => b.rejects - a.rejects || b.decisions - a.decisions);

  const alerts = moduleRows
    .filter(m => m.decisions >= 20 && m.rejectRate > 0.5 && m.avgConfidence < 0.7)
    .map(m => ({
      level: "warning",
      code: "MODULE_REJECT_RATE_HIGH_LOW_CONFIDENCE",
      message: `Module ${m.id} appears aggressive: reject rate ${(m.rejectRate * 100).toFixed(1)}% at avg confidence ${m.avgConfidence.toFixed(2)}`,
    }));

  return json({
    data: {
      window: { from: dateFrom, to: dateTo },
      sampled: {
        traces: fetched,
        maxItems,
      },
      totals,
      confidence: {
        buckets: confidenceBuckets.map(bucket => ({
          min: bucket.min,
          max: Math.min(bucket.max, 1),
          count: bucket.count,
        })),
      },
      domains: domainRows,
      modules: moduleRows,
      thresholdPressure,
      alerts,
    },
  });
}

export async function handleCreateSimulation(req: Request, deps: MRFAdminDeps): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:simulate");

  const actor = deps.actorFromRequest(req);
  const requestId = req.headers.get("x-request-id") || deps.uuid();

  const body = parseWithSchema(simulateSchema, await parseJson(req));
  const jobId = deps.uuid();

  const job = {
    jobId,
    status: "queued" as const,
    activityId: body.activityId,
    inlinePayloadHash: body.payload ? deps.uuid() : undefined,
    requestedModules: body.modules,
    requestedBy: actor,
    createdAt: deps.now(),
    updatedAt: deps.now(),
  };

  await deps.store.createSimulationJob(job);
  await deps.enqueueSimulation(jobId);

  await deps.audit.log({
    type: "simulation.create",
    actor,
    requestId,
    sourceIp: deps.sourceIpFromRequest(req),
    target: jobId,
    after: job,
    createdAt: deps.now(),
  });

  return json({ data: job }, 202);
}

export async function handleGetSimulation(
  req: Request,
  deps: MRFAdminDeps,
  jobId: string,
): Promise<Response> {
  assertAdminBearer(req.headers, deps.adminToken);
  deps.authorize(req, "provider:simulate");

  const job = await deps.store.getSimulationJob(jobId);
  if (!job) throw notFound("Simulation job not found");

  return json({ data: job });
}
