import { describe, expect, it, vi } from "vitest";
import { handlePatchModule } from "./handlers.js";
import type { MRFAdminDeps, MRFModuleConfig, MRFModuleManifest } from "./types.js";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/internal/admin/mrf/modules/trust-eval", {
    method: "PATCH",
    headers: {
      authorization: "Bearer token-123",
      "content-type": "application/json",
      "x-request-id": "req-1",
    },
    body: JSON.stringify(body),
  });
}

function makeDeps(config: MRFModuleConfig): MRFAdminDeps {
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

  const store = {
    listModuleManifests: vi.fn().mockResolvedValue([manifest]),
    getModuleManifest: vi.fn().mockResolvedValue(manifest),
    getModuleConfig: vi.fn().mockResolvedValue(config),
    setModuleConfig: vi.fn().mockResolvedValue(undefined),
    getChainConfig: vi.fn(),
    setChainConfig: vi.fn(),
    listTraces: vi.fn(),
    getTrace: vi.fn(),
    createSimulationJob: vi.fn(),
    getSimulationJob: vi.fn(),
  };

  return {
    adminToken: "token-123",
    store,
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

describe("handlePatchModule", () => {
  it("does not persist invalid module config", async () => {
    const deps = makeDeps({
      enabled: true,
      mode: "dry-run",
      priority: 30,
      stopOnMatch: false,
      config: {
        thresholdLabel: 0.3,
        thresholdDownrank: 0.45,
        thresholdFilter: 0.7,
        thresholdReject: 0.9,
        defaultWeight: 1,
        maxSourcesPerUser: 100,
        allowedScopes: ["filter:content", "label:content"],
        enabledDecisionActions: ["label"],
        traceReasons: true,
      },
      updatedAt: "2026-04-05T00:00:00.000Z",
      updatedBy: "system",
      revision: 1,
    });

    await expect(
      handlePatchModule(
        makeRequest({ config: { unknownSetting: true }, expectedRevision: 1 }),
        deps,
        "trust-eval",
      ),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(deps.store.setModuleConfig).not.toHaveBeenCalled();
  });

  it("persists valid patch and increments revision", async () => {
    const deps = makeDeps({
      enabled: true,
      mode: "dry-run",
      priority: 30,
      stopOnMatch: false,
      config: {
        thresholdLabel: 0.3,
        thresholdDownrank: 0.45,
        thresholdFilter: 0.7,
        thresholdReject: 0.9,
        defaultWeight: 1,
        maxSourcesPerUser: 100,
        allowedScopes: ["filter:content", "label:content"],
        enabledDecisionActions: ["label"],
        traceReasons: true,
      },
      updatedAt: "2026-04-05T00:00:00.000Z",
      updatedBy: "system",
      revision: 1,
    });

    const response = await handlePatchModule(
      makeRequest({ config: { thresholdReject: 0.95 }, expectedRevision: 1 }),
      deps,
      "trust-eval",
    );

    expect(response.status).toBe(200);
    expect(deps.store.setModuleConfig).toHaveBeenCalledTimes(1);
    const setModuleConfigMock = deps.store.setModuleConfig as ReturnType<typeof vi.fn>;
    const firstCall = setModuleConfigMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const persisted = firstCall?.[1] as MRFModuleConfig;
    expect(persisted.revision).toBe(2);
    expect((persisted.config["thresholdReject"] as number)).toBe(0.95);
  });

  it("returns warnings but still persists config", async () => {
    const deps = makeDeps({
      enabled: true,
      mode: "dry-run",
      priority: 30,
      stopOnMatch: false,
      config: {
        thresholdLabel: 0.3,
        thresholdDownrank: 0.45,
        thresholdFilter: 0.7,
        thresholdReject: 0.9,
        defaultWeight: 1,
        maxSourcesPerUser: 100,
        allowedScopes: ["filter:content", "label:content"],
        enabledDecisionActions: ["label"],
        traceReasons: true,
      },
      updatedAt: "2026-04-05T00:00:00.000Z",
      updatedBy: "system",
      revision: 1,
    });

    const response = await handlePatchModule(
      makeRequest({ config: { enabledDecisionActions: ["reject"] }, expectedRevision: 1 }),
      deps,
      "trust-eval",
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { warnings?: string[] };
    expect(payload.warnings?.length).toBeGreaterThan(0);
    expect(deps.store.setModuleConfig).toHaveBeenCalledTimes(1);
  });
});
