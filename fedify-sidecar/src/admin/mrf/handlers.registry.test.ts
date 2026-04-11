import { describe, expect, it, vi } from "vitest";
import { handleGetRegistryItem, handleListRegistry } from "./handlers.js";
import type { MRFAdminDeps, MRFModuleManifest } from "./types.js";

function makeDeps(): MRFAdminDeps {
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
      listTraces: vi.fn(),
      getTrace: vi.fn(),
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

describe("registry handlers", () => {
  it("list registry requires auth", async () => {
    const deps = makeDeps();
    const req = new Request("http://localhost/internal/admin/mrf/registry", {
      method: "GET",
      headers: {
        "x-provider-permissions": "provider:read",
      },
    });

    await expect(handleListRegistry(req, deps)).rejects.toMatchObject({ status: 401 });
  });

  it("get registry item returns 404 for unknown module", async () => {
    const deps = makeDeps();
    const req = new Request("http://localhost/internal/admin/mrf/registry/unknown", {
      method: "GET",
      headers: {
        authorization: "Bearer token-123",
        "x-provider-permissions": "provider:read",
      },
    });

    await expect(handleGetRegistryItem(req, deps, "unknown")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("get registry item returns stable descriptor shape", async () => {
    const deps = makeDeps();
    const req = new Request("http://localhost/internal/admin/mrf/registry/trust-eval", {
      method: "GET",
      headers: {
        authorization: "Bearer token-123",
        "x-provider-permissions": "provider:read",
      },
    });

    const response = await handleGetRegistryItem(req, deps, "trust-eval");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        manifest: { id: string };
        ui: { category: string };
        config: { fields: Array<{ key: string }>; defaults: Record<string, unknown> };
      };
    };

    expect(payload.data.manifest.id).toBe("trust-eval");
    expect(payload.data.ui.category).toBe("trust");
    expect(payload.data.config.fields.length).toBeGreaterThan(0);
    expect(payload.data.config.defaults).toBeTypeOf("object");
  });
});
