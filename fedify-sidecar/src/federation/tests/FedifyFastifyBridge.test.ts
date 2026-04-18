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
});
