import { describe, expect, it, vi } from "vitest";
import {
  handleGetMetrics,
  handleGetTraceDecisionChain,
  handleGetTraceSuggestions,
} from "./handlers.js";
import type { MRFAdminDeps, MRFDecisionTrace, MRFModuleManifest } from "./types.js";

function sampleTrace(overrides: Partial<MRFDecisionTrace> = {}): MRFDecisionTrace {
  return {
    traceId: "trace-1",
    requestId: "req-1",
    activityId: "https://example.org/activities/1",
    moduleId: "trust-eval",
    mode: "dry-run",
    action: "label",
    confidence: 0.42,
    originHost: "example.org",
    createdAt: "2026-04-05T00:00:00.000Z",
    redacted: false,
    ...overrides,
  };
}

function makeDeps(traces: MRFDecisionTrace[]): MRFAdminDeps {
  const manifest: MRFModuleManifest = {
    id: "trust-eval",
    name: "Trust Evaluation",
    version: "1.0.0",
    kind: "wasm",
    allowedActions: ["label", "downrank", "filter", "reject"],
    defaultMode: "dry-run",
    defaultPriority: 30,
    configSchemaVersion: 1,
  };

  return {
    adminToken: "token-123",
    store: {
      listModuleManifests: vi.fn().mockResolvedValue([manifest]),
      getModuleManifest: vi.fn().mockResolvedValue(manifest),
      getModuleConfig: vi.fn().mockResolvedValue(null),
      setModuleConfig: vi.fn().mockResolvedValue(undefined),
      getChainConfig: vi.fn(),
      setChainConfig: vi.fn(),
      listTraces: vi.fn().mockResolvedValue({ items: traces, nextCursor: undefined }),
      getTrace: vi.fn().mockImplementation(async (id: string) => traces.find(t => t.traceId === id) || null),
      appendTrace: vi.fn().mockResolvedValue(undefined),
      createSimulationJob: vi.fn(),
      getSimulationJob: vi.fn(),
    },
    audit: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    now: () => "2026-04-05T00:00:00.000Z",
    uuid: () => "uuid-1",
    actorFromRequest: () => "tester",
    sourceIpFromRequest: () => "127.0.0.1",
    authorize: () => {},
    enqueueSimulation: vi.fn().mockResolvedValue(undefined),
  };
}

function authedRequest(url: string): Request {
  return new Request(url, {
    method: "GET",
    headers: {
      authorization: "Bearer token-123",
      "x-provider-permissions": "provider:read",
    },
  });
}

describe("insights handlers", () => {
  it("returns decision chain for related traces in execution order", async () => {
    const traces = [
      sampleTrace({ traceId: "t2", createdAt: "2026-04-05T00:00:02.000Z", action: "filter" }),
      sampleTrace({ traceId: "t1", createdAt: "2026-04-05T00:00:01.000Z", action: "label" }),
    ];
    const deps = makeDeps(traces);

    const response = await handleGetTraceDecisionChain(
      authedRequest("http://localhost/internal/admin/mrf/traces/t1/chain"),
      deps,
      "t1",
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { steps: Array<{ traceId: string }>; finalAction: string } };
    expect(payload.data.steps.map(step => step.traceId)).toEqual(["t1", "t2"]);
    expect(payload.data.finalAction).toBe("filter");
  });

  it("returns safe suggestions for trust-eval traces", async () => {
    const traces = [sampleTrace({ traceId: "t1", action: "reject", confidence: 0.8 })];
    const deps = makeDeps(traces);

    const response = await handleGetTraceSuggestions(
      authedRequest("http://localhost/internal/admin/mrf/traces/t1/suggestions"),
      deps,
      "t1",
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { moduleId: string; suggestions: Array<{ field: string; type: string }> };
    };

    expect(payload.data.moduleId).toBe("trust-eval");
    expect(payload.data.suggestions.some(item => item.field === "thresholdReject" && item.type === "increase")).toBe(
      true,
    );
  });

  it("aggregates metrics across traces", async () => {
    const traces = [
      sampleTrace({ traceId: "a", action: "label", confidence: 0.41, originHost: "a.example" }),
      sampleTrace({ traceId: "b", action: "reject", confidence: 0.91, originHost: "a.example" }),
      sampleTrace({ traceId: "c", moduleId: "spam-filter", action: "filter", confidence: 0.76, originHost: "b.example" }),
    ];

    const deps = makeDeps(traces);
    const response = await handleGetMetrics(
      authedRequest("http://localhost/internal/admin/mrf/metrics?maxItems=100"),
      deps,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        totals: { decisions: number; byAction: Record<string, number> };
        modules: Array<{ id: string; decisions: number }>;
      };
    };

    expect(payload.data.totals.decisions).toBe(3);
    expect(payload.data.totals.byAction['reject']).toBe(1);
    expect(payload.data.modules.find(m => m.id === "trust-eval")?.decisions).toBe(2);
  });
});
