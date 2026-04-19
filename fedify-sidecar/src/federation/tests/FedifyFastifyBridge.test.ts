vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFedifyRoutes } from "../FedifyFastifyBridge.js";
import type { FedifyFederationAdapter } from "../FedifyFederationAdapter.js";

function createAppWithBridge(fetchSpy: ReturnType<typeof vi.fn>) {
  const app = Fastify({ logger: false, trustProxy: true });
  app.addContentTypeParser(
    ["application/activity+json", "application/ld+json", "application/json"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  const adapter = {
    buildContext: vi.fn((request?: { ip?: string }) => ({
      domain: "fed.example.com",
      activityPodsUrl: "http://localhost:3000",
      activityPodsToken: "token",
      remoteIp: request?.ip ?? "unknown",
      enqueueVerifiedInbox: undefined,
    })),
    getFederation: () => ({
      fetch: fetchSpy,
    }),
  } as unknown as FedifyFederationAdapter;

  registerFedifyRoutes(app, adapter);
  return { app, adapter };
}

describe("FedifyFastifyBridge", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the shared inbox POST route through Fedify", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (request: Request) => {
      const body = await request.text();
      return new Response(
        JSON.stringify({
          method: request.method,
          url: request.url,
          body,
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const { app, adapter } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "POST",
      url: "/inbox",
      headers: { "content-type": "application/activity+json" },
      payload: JSON.stringify({ type: "Follow" }),
    });

    expect(response.statusCode).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [request, options] =
      (fetchSpy.mock.calls as Array<[Request, { contextData?: { remoteIp?: string } } | undefined]>)[0] ?? [];
    expect(request).toBeInstanceOf(Request);
    expect(request?.method).toBe("POST");
    expect(request?.url).toContain("/inbox");
    expect(options?.contextData?.remoteIp).toBeTypeOf("string");
    expect((adapter as any).buildContext).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("serves host-meta discovery without going through Fedify", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(null, { status: 204 }),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/host-meta",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/xrd+xml");
    expect(response.body).toContain("/.well-known/webfinger?resource={uri}");
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("serves actor-uri webfinger locally without going through Fedify", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(null, { status: 204 }),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/webfinger",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
      query: {
        resource: "https://sidecar/users/alice",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/jrd+json");
    expect(response.json()).toEqual({
      subject: "https://sidecar/users/alice",
      aliases: ["https://sidecar/users/alice"],
      links: [
        {
          rel: "self",
          type: "application/activity+json",
          href: "https://sidecar/users/alice",
        },
      ],
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not claim the per-user inbox POST route", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(null, { status: 202 }),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "POST",
      url: "/users/alice/inbox",
      headers: { "content-type": "application/activity+json" },
      payload: JSON.stringify({ type: "Create" }),
    });

    expect(response.statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("serves RSS syndication when .rss is appended to an actor URL", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          name: "alice",
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice.rss",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/rss+xml");
    expect(response.body).toContain("<rss version=\"2.0\">");
    expect(response.body).toContain("https://sidecar/users/alice");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("serves Atom syndication when .atom is appended to an actor URL", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          name: "alice",
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice.atom",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/atom+xml");
    expect(response.body).toContain("<feed xmlns=\"http://www.w3.org/2005/Atom\">");
    expect(response.body).toContain("https://sidecar/users/alice");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("serves RSS syndication for mirrored profile URLs", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/@alice@example.org",
          type: "Person",
          name: "alice@example.org",
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/@alice@example.org.rss",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/rss+xml");
    expect(response.body).toContain("https://sidecar/@alice@example.org");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("serves fallback RSS syndication when source object is missing", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({ error: "Not Found" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/missing.rss",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/rss+xml");
    expect(response.body).toContain("<rss version=\"2.0\">");
    expect(response.body).toContain("https://sidecar/users/missing");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns actor-relative redirect when service and relativeRef query params are present", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          service: [
            {
              id: "https://sidecar/users/alice#storage",
              serviceEndpoint: "https://storage-provider.example",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice?service=storage&relativeRef=/AP/objects/567",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://storage-provider.example/AP/objects/567");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns 422 for actor-relative query when actor lacks matching storage endpoint", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          service: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice?service=storage&relativeRef=/AP/objects/567",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "Missing or invalid actor service endpoint" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("falls back to configured storage endpoint when actor service is null", async () => {
    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          service: null,
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice?service=storage&relativeRef=/AP/objects/567",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://localhost:3000/AP/objects/567");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("injects ActorStatus metadata from the internal ActivityPods actor document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://localhost:3000/api/internal/actors/alice") {
          return new Response(
            JSON.stringify({
              id: "https://pods.example/users/alice",
              status: {
                type: "ActorStatus",
                id: "https://pods.example/users/alice/statuses/current",
                attributedTo: "https://pods.example/users/alice",
                content: "Shipping ActorStatus support",
                published: "2030-01-01T12:00:00.000Z",
              },
              statusHistory: "https://pods.example/users/alice/statusHistory",
            }),
            {
              status: 200,
              headers: { "content-type": "application/activity+json" },
            },
          );
        }

        return new Response(null, { status: 404 });
      }),
    );

    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          name: "alice",
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "https://sidecar/users/alice",
      type: "Person",
      status: {
        type: "ActorStatus",
        id: "https://pods.example/users/alice/statuses/current",
        attributedTo: "https://sidecar/users/alice",
        content: "Shipping ActorStatus support",
        published: "2030-01-01T12:00:00.000Z",
      },
      statusHistory: "https://sidecar/users/alice/statusHistory",
    });
    expect(response.body).toContain('"ActorStatus":"sm:ActorStatus"');

    await app.close();
  });

  it("injects actor search-consent metadata from the internal ActivityPods actor document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://localhost:3000/api/internal/actors/alice") {
          return new Response(
            JSON.stringify({
              id: "https://pods.example/users/alice",
              searchableBy: "https://www.w3.org/ns/activitystreams#Public",
              indexable: true,
            }),
            {
              status: 200,
              headers: { "content-type": "application/activity+json" },
            },
          );
        }

        return new Response(null, { status: 404 });
      }),
    );

    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          name: "alice",
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "https://sidecar/users/alice",
      type: "Person",
      searchableBy: "https://www.w3.org/ns/activitystreams#Public",
      indexable: true,
    });
    expect(response.body).toContain("https://w3id.org/fep/268d");
    expect(response.body).toContain('"indexable":"toot:indexable"');

    await app.close();
  });

  it("filters expired actor status values from the public actor document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://localhost:3000/api/internal/actors/alice") {
          return new Response(
            JSON.stringify({
              id: "https://pods.example/users/alice",
              status: {
                type: "ActorStatus",
                id: "https://pods.example/users/alice/statuses/expired",
                attributedTo: "https://pods.example/users/alice",
                content: "Expired",
                published: "2029-12-30T12:00:00.000Z",
                endTime: "2029-12-31T00:00:00.000Z",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/activity+json" },
            },
          );
        }

        return new Response(null, { status: 404 });
      }),
    );

    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(
        JSON.stringify({
          id: "https://sidecar/users/alice",
          type: "Person",
          name: "alice",
        }),
        {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        },
      ),
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("status");

    await app.close();
    vi.useRealTimers();
  });

  it("serves actor status history through a sidecar-owned collection route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://localhost:3000/api/internal/actors/alice/status-history") {
          return new Response(
            JSON.stringify({
              orderedItems: [
                {
                  id: "https://pods.example/users/alice/statuses/1",
                  type: "ActorStatus",
                  attributedTo: "https://pods.example/users/alice",
                  content: "Morning focus mode",
                  published: "2030-01-01T09:00:00.000Z",
                },
                {
                  id: "https://pods.example/users/alice/statuses/2",
                  type: "ActorStatus",
                  attributedTo: "https://pods.example/users/alice",
                  content: "Pairing on the sidecar bridge",
                  published: "2030-01-01T10:00:00.000Z",
                  endTime: "2030-01-01T11:00:00.000Z",
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/activity+json" },
            },
          );
        }

        return new Response(null, { status: 404 });
      }),
    );

    const fetchSpy = vi.fn<
      (request: Request, options?: { contextData?: { remoteIp?: string } }) => Promise<Response>
    >(async (_request: Request) =>
      new Response(null, { status: 404 }),
    );

    const { app } = createAppWithBridge(fetchSpy);
    const response = await app.inject({
      method: "GET",
      url: "/users/alice/statusHistory",
      headers: {
        host: "sidecar",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/activity+json");
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        {
          sm: "http://smithereen.software/ns#",
          ActorStatus: "sm:ActorStatus",
          status: {
            "@type": "@id",
            "@id": "sm:status",
          },
          statusHistory: {
            "@type": "@id",
            "@id": "sm:statusHistory",
          },
        },
      ],
      id: "https://sidecar/users/alice/statusHistory",
      type: "OrderedCollection",
      totalItems: 2,
      orderedItems: [
        {
          id: "https://pods.example/users/alice/statuses/1",
          type: "ActorStatus",
          attributedTo: "https://sidecar/users/alice",
          content: "Morning focus mode",
          published: "2030-01-01T09:00:00.000Z",
        },
        {
          id: "https://pods.example/users/alice/statuses/2",
          type: "ActorStatus",
          attributedTo: "https://sidecar/users/alice",
          content: "Pairing on the sidecar bridge",
          published: "2030-01-01T10:00:00.000Z",
          endTime: "2030-01-01T11:00:00.000Z",
        },
      ],
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });
});
