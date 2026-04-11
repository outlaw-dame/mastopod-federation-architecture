import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMRFAdminFastifyRoutes } from "./fastify-routes.js";
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

describe("registry routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns application/json for registry list", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    registerMRFAdminFastifyRoutes(app, makeDeps());

    const response = await app.inject({
      method: "GET",
      url: "/internal/admin/mrf/registry",
      headers: {
        authorization: "Bearer token-123",
        "x-provider-permissions": "provider:read",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("preserves request id in error payloads", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    registerMRFAdminFastifyRoutes(app, makeDeps());

    const response = await app.inject({
      method: "GET",
      url: "/internal/admin/mrf/registry/unknown-module",
      headers: {
        authorization: "Bearer token-123",
        "x-provider-permissions": "provider:read",
        "x-request-id": "req-registry-404",
      },
    });

    expect(response.statusCode).toBe(404);
    const payload = response.json() as {
      error: {
        requestId?: string;
      };
    };
    expect(payload.error.requestId).toBe("req-registry-404");
    await app.close();
  });
});
