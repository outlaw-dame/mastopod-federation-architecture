import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFeedFastifyRoutes } from "../fastify-routes.js";
import { FeedRegistry } from "../FeedRegistry.js";
import { PodFeedServiceError } from "../PodFeedService.js";
import {
  DurableStreamSubscriptionService,
  buildCapabilityLookup,
} from "../DurableStreamSubscriptionService.js";

const authHeaders = {
  authorization: "Bearer test-token",
  "x-provider-permissions": "provider:read",
};

function createRegistry() {
  return new FeedRegistry([
    {
      id: "urn:activitypods:feed:public-discovery:v1",
      kind: "discovery",
      visibility: "public",
      sourcePolicy: {
        includeStream1: false,
        includeStream2: true,
        includeCanonical: true,
        includeFirehose: false,
        includeUnified: false,
      },
      rankingPolicy: { mode: "ranked" },
      hydrationShape: "card",
      realtimeCapable: true,
      supportsSse: true,
      supportsWebSocket: true,
      experimental: false,
      providerId: "test.provider",
    },
  ]);
}

async function createApp(overrides?: {
  listFeeds?: ReturnType<typeof vi.fn>;
  getFeed?: ReturnType<typeof vi.fn>;
  hydrate?: ReturnType<typeof vi.fn>;
  viewershipHistoryClient?: {
    resolveViewedObjectIds: ReturnType<typeof vi.fn>;
    recordView: ReturnType<typeof vi.fn>;
  };
}) {
  const app = Fastify();

  const feedService = {
    listFeeds: overrides?.listFeeds ?? vi.fn().mockReturnValue([]),
    getFeed: overrides?.getFeed
      ?? vi.fn().mockResolvedValue({
        items: [
          {
            stableId: "post-1",
            canonicalUri: "https://example.com/objects/1",
            activityPubObjectId: "https://example.com/objects/1",
            source: "stream2",
          },
        ],
        capabilities: {
          hydrationRequired: true,
          realtimeAvailable: true,
          supportsSse: true,
          supportsWebSocket: true,
        },
      }),
  };

  const hydrationService = {
    hydrate: overrides?.hydrate ?? vi.fn().mockResolvedValue({
      items: [
        {
          id: "https://example.com/objects/1",
          type: "Note",
          provenance: { source: "stream2" },
        },
      ],
    }),
  };

  registerFeedFastifyRoutes(app, {
    sidecarToken: "test-token",
    feedRegistry: createRegistry(),
    feedService: feedService as any,
    hydrationService: hydrationService as any,
    viewershipHistoryClient: overrides?.viewershipHistoryClient as any,
  });

  await app.ready();
  return { app, feedService, hydrationService };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feed fastify routes", () => {
  it("rejects unauthorized feed definitions access", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/definitions",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects wrong bearer token", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/definitions",
      headers: {
        authorization: "Bearer wrong-token",
        "x-provider-permissions": "provider:read",
      },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects feed query without provider read permission", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/feed/query",
      headers: {
        authorization: "Bearer test-token",
      },
      payload: {
        feedId: "urn:activitypods:feed:public-discovery:v1",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("returns 400 on invalid feed query payload", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/feed/query",
      headers: authHeaders,
      payload: {
        feedId: "urn:activitypods:feed:public-discovery:v1",
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("maps PodFeedServiceError into structured response", async () => {
    const { app } = await createApp({
      getFeed: vi
        .fn()
        .mockRejectedValue(new PodFeedServiceError("Feed requires authentication", {
          code: "AUTHENTICATION_REQUIRED",
          statusCode: 401,
        })),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/feed/query",
      headers: authHeaders,
      payload: {
        feedId: "urn:activitypods:feed:public-discovery:v1",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "authentication_required",
      message: "Feed requires authentication",
      retryable: false,
    });
    await app.close();
  });

  it("filters viewed objects when excludeViewed is enabled", async () => {
    const viewershipHistoryClient = {
      resolveViewedObjectIds: vi.fn().mockResolvedValue({
        viewedObjectIds: ["https://example.com/objects/1"],
      }),
      recordView: vi.fn(),
    };

    const { app } = await createApp({ viewershipHistoryClient });
    const response = await app.inject({
      method: "POST",
      url: "/internal/feed/query",
      headers: authHeaders,
      payload: {
        feedId: "urn:activitypods:feed:public-discovery:v1",
        viewerId: "https://pods.example/alice",
        limit: 10,
        excludeViewed: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(viewershipHistoryClient.resolveViewedObjectIds).toHaveBeenCalledTimes(1);
    expect(response.json().items).toHaveLength(0);
    await app.close();
  });

  it("records viewed objects through the internal viewed endpoint", async () => {
    const viewershipHistoryClient = {
      resolveViewedObjectIds: vi.fn(),
      recordView: vi.fn().mockResolvedValue(undefined),
    };

    const { app } = await createApp({ viewershipHistoryClient });
    const response = await app.inject({
      method: "POST",
      url: "/internal/feed/viewed",
      headers: {
        authorization: "Bearer test-token",
        "x-provider-permissions": "provider:read,provider:write",
      },
      payload: {
        viewerId: "https://pods.example/alice",
        objectIds: ["https://example.com/objects/1", "https://example.com/objects/1"],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(viewershipHistoryClient.recordView).toHaveBeenCalledWith({
      actorId: "https://pods.example/alice",
      objectIds: ["https://example.com/objects/1"],
      viewedAt: undefined,
    });
    await app.close();
  });

  it("returns hydrated payload when request is valid", async () => {
    const { app, hydrationService } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/feed/hydrate",
      headers: authHeaders,
      payload: {
        shape: "card",
        items: [
          {
            stableId: "post-1",
            canonicalUri: "https://example.com/objects/1",
            source: "stream2",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(hydrationService.hydrate).toHaveBeenCalledTimes(1);
    expect(response.json().items).toHaveLength(1);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["pragma"]).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// SSE /internal/feed/stream route tests
// ---------------------------------------------------------------------------
function makeSseCapabilityLookup() {
  return buildCapabilityLookup([
    {
      stream: "stream1",
      supportsSse: true,
      supportsWebSocket: true,
      requiresAuthentication: false,
      replayCapable: true,
    },
  ]);
}

async function createSseApp(streamSvc?: DurableStreamSubscriptionService) {
  const app = Fastify();
  const feedService = {
    listFeeds: vi.fn().mockReturnValue([]),
    getFeed: vi.fn().mockResolvedValue({ items: [], capabilities: { hydrationRequired: true, realtimeAvailable: false, supportsSse: false, supportsWebSocket: false } }),
  };
  const hydrationService = { hydrate: vi.fn().mockResolvedValue({ items: [] }) };

  registerFeedFastifyRoutes(app, {
    sidecarToken: "test-token",
    feedRegistry: createRegistry(),
    feedService: feedService as any,
    hydrationService: hydrationService as any,
    streamSubscriptionService: streamSvc,
  });

  await app.ready();
  return app;
}

describe("SSE /internal/feed/stream route", () => {
  it("returns 501 when streamSubscriptionService is not configured", async () => {
    const app = await createSseApp(undefined);
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/stream",
      query: { transport: "sse", streams: "stream1" },
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it("returns 401 with missing authorization", async () => {
    const svc = new DurableStreamSubscriptionService({
      sidecarToken: "test-token",
      capabilityLookup: makeSseCapabilityLookup(),
    });
    const app = await createSseApp(svc);
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/stream",
      query: { transport: "sse", streams: "stream1" },
      headers: { "x-provider-permissions": "provider:read" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 403 with missing provider:read permission", async () => {
    const svc = new DurableStreamSubscriptionService({
      sidecarToken: "test-token",
      capabilityLookup: makeSseCapabilityLookup(),
    });
    const app = await createSseApp(svc);
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/stream",
      query: { transport: "sse", streams: "stream1" },
      headers: {
        authorization: "Bearer test-token",
      },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 for unknown stream", async () => {
    const svc = new DurableStreamSubscriptionService({
      sidecarToken: "test-token",
      capabilityLookup: makeSseCapabilityLookup(),
    });
    const app = await createSseApp(svc);
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/stream",
      query: { transport: "sse", streams: "firehose" },
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 503 when at connection capacity", async () => {
    const svc = new DurableStreamSubscriptionService({
      sidecarToken: "test-token",
      capabilityLookup: makeSseCapabilityLookup(),
      maxConnections: 0, // immediately at capacity
    });
    const app = await createSseApp(svc);
    const response = await app.inject({
      method: "GET",
      url: "/internal/feed/stream",
      query: { transport: "sse", streams: "stream1" },
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
