import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAtIdentityObservabilityFastifyRoutes } from "./fastify-routes.js";
import type { ObservedAtIdentityStore } from "../../protocol-bridge/identity/ObservedAtIdentityStore.js";

function createStore(): ObservedAtIdentityStore {
  return {
    observe: async () => {
      throw new Error("not used");
    },
    getByDid: async () => null,
    listAll: async () => [],
    getSummary: async () => ({
      totalObserved: 2,
      boundObserved: 1,
      unboundObserved: 1,
      projectedCount: 5,
      skippedUnboundActorCount: 7,
      skippedOtherCount: 1,
      failedCount: 0,
    }),
    listTopUnbound: async () => [{
      did: "did:plc:external",
      handle: "external.example",
      pdsEndpoint: "https://pds.example",
      canonicalAccountId: null,
      activityPubActorUri: null,
      bound: false,
      firstSeenAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:10:00.000Z",
      totalSeen: 10,
      projectedCount: 0,
      skippedUnboundActorCount: 10,
      skippedOtherCount: 0,
      failedCount: 0,
      lastOutcome: "skipped_unbound_actor",
    }],
    listTopBound: async () => [{
      did: "did:plc:local",
      handle: "local.example",
      pdsEndpoint: "https://pds.local",
      canonicalAccountId: "acct:1",
      activityPubActorUri: "https://example.com/users/local",
      bound: true,
      firstSeenAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:10:00.000Z",
      totalSeen: 8,
      projectedCount: 8,
      skippedUnboundActorCount: 0,
      skippedOtherCount: 0,
      failedCount: 0,
      lastOutcome: "projected",
    }],
    listRecent: async () => [],
  };
}

describe("registerAtIdentityObservabilityFastifyRoutes", () => {
  it("requires auth and read permission", async () => {
    const app = Fastify();
    registerAtIdentityObservabilityFastifyRoutes(app, {
      adminToken: "secret-token",
      store: createStore(),
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/internal/admin/at-observability/identities",
      headers: {
        "accept-language": "es-MX,es;q=0.9",
      },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["content-language"]).toBe("es");
    expect(unauthorized.headers.vary).toContain("Accept-Language");
    expect(unauthorized.json()).toEqual({
      error: "unauthorized",
      message: "No autorizado",
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/internal/admin/at-observability/identities",
      headers: {
        authorization: "Bearer secret-token",
        "accept-language": "es-ES",
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers["content-language"]).toBe("es");
    expect(forbidden.json()).toEqual({
      error: "forbidden",
      message: "Falta el permiso requerido: provider:read",
    });
    await app.close();
  });

  it("returns summary and top lists when authorized", async () => {
    const app = Fastify();
    registerAtIdentityObservabilityFastifyRoutes(app, {
      adminToken: "secret-token",
      store: createStore(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/admin/at-observability/identities?limit=10",
      headers: {
        authorization: "Bearer secret-token",
        "x-provider-permissions": "provider:read",
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.summary.totalObserved).toBe(2);
    expect(payload.topUnbound[0].did).toBe("did:plc:external");
    expect(payload.topBound[0].activityPubActorUri).toBe("https://example.com/users/local");
    expect(payload.queries.skipped).toContain("outcome=\"skipped\"");
    await app.close();
  });
});
