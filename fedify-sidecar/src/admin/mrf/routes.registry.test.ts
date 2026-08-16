import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MRF_EFFECTIVE_CLIENT_IP_HEADER,
  registerMRFAdminFastifyRoutes,
} from "./fastify-routes.js";
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

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer token-123",
    "x-provider-permissions": "provider:read",
    ...extra,
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
      headers: adminHeaders(),
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
      headers: adminHeaders({ "x-request-id": "req-registry-404" }),
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

  it("overwrites caller-supplied effective client identity before Web Request handlers", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    const deps = makeDeps();
    const observed = vi.fn();
    deps.authorize = (request) => {
      observed(request.headers.get(MRF_EFFECTIVE_CLIENT_IP_HEADER));
    };
    registerMRFAdminFastifyRoutes(app, deps, {
      clientIpResolver: () => "203.0.113.44",
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/admin/mrf/registry",
      headers: adminHeaders({
        [MRF_EFFECTIVE_CLIENT_IP_HEADER]: "198.51.100.200",
        "x-forwarded-for": "192.0.2.88",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(observed).toHaveBeenCalledWith("203.0.113.44");
    await app.close();
  });

  it("uses resolver-derived identity for rate limits even when Fastify trusts rotating X-Forwarded-For", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    registerMRFAdminFastifyRoutes(app, makeDeps(), {
      clientIpResolver: () => "203.0.113.44",
    });

    let response;
    for (let index = 0; index < 121; index += 1) {
      response = await app.inject({
        method: "GET",
        url: "/internal/admin/mrf/registry",
        headers: adminHeaders({
          "x-forwarded-for": `198.51.100.${(index % 250) + 1}`,
        }),
      });
    }

    expect(response?.statusCode).toBe(429);
    await app.close();
  });
});
