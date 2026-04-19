import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFep3ab2Routes } from "../Fep3ab2FastifyRoutes.js";
import { FepAuthorityClientError } from "../Fep3ab2ActivityPodsClient.js";
import { Fep3ab2EventHub } from "../Fep3ab2EventHub.js";
import { Fep3ab2ReplayStore, buildReplayEventId } from "../Fep3ab2ReplayStore.js";
import { Fep3ab2SessionStore } from "../Fep3ab2SessionStore.js";
import { MemoryRedis } from "./MemoryRedis.js";

const PRINCIPAL = "https://example.com/users/alice";
const USER_AUTH_HEADER = "Bearer user-auth-token";

function createAuthorityClient() {
  return {
    resolvePrincipal: vi.fn(async (context: { authorization?: string }) => {
      if (context.authorization === USER_AUTH_HEADER) {
        return { principal: PRINCIPAL };
      }
      throw new FepAuthorityClientError("login required", "login_required", 401);
    }),
    authorizeTopics: vi.fn(async (_principal: string, topics: string[]) => {
      const deniedTopics = topics
        .filter((topic) => topic === "notifications")
        .map((topic) => ({ topic, reasonCode: "private_topic_not_enabled" }));
      return {
        allowedTopics: topics.filter((topic) => topic !== "notifications"),
        deniedTopics,
      };
    }),
  };
}

async function buildApp() {
  const app = Fastify();
  const redis = new MemoryRedis();
  const sessionStore = new Fep3ab2SessionStore(redis as any, {
    ticketSecret: "test-secret",
    ticketTtlSec: 300,
  });
  const eventHub = new Fep3ab2EventHub(60_000);
  const replayStore = new Fep3ab2ReplayStore(redis as any, {
    prefix: "test-fep",
    ttlSec: 300,
    maxReplayEvents: 50,
  });
  const authorityClient = createAuthorityClient();

  registerFep3ab2Routes(app, {
    authorityClient: authorityClient as any,
    sessionStore,
    eventHub,
    replayStore,
    cookieSecure: false,
  });

  await app.ready();
  return { app, sessionStore, eventHub, replayStore, authorityClient };
}

function getCookie(response: { headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(raw) ? raw[0] : raw;
  if (typeof cookieHeader !== "string" || !cookieHeader) {
    throw new Error("missing set-cookie header");
  }
  return cookieHeader.split(";")[0] ?? cookieHeader;
}

describe("Fep3ab2FastifyRoutes", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it("creates a control session and returns the ticket cookie", async () => {
    const runtime = await buildApp();
    apps.push(runtime.app);

    const response = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: {
        authorization: USER_AUTH_HEADER,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      wildcard_support: true,
      subscriptions_url: expect.stringContaining("/streaming/control/subscriptions"),
      stream_url: expect.stringContaining("/streaming/stream"),
    });
    expect(getCookie(response)).toContain("ap_stream_ticket=");
  });

  it("accepts bounded wildcard URI subscriptions and rejects denied topics", async () => {
    const runtime = await buildApp();
    apps.push(runtime.app);

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { authorization: USER_AUTH_HEADER },
    });
    const cookie = getCookie(sessionResponse);

    const deniedResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: {
        authorization: USER_AUTH_HEADER,
        cookie,
      },
      payload: {
        topics: ["notifications"],
      },
    });
    expect(deniedResponse.statusCode).toBe(403);

    const addResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: {
        authorization: USER_AUTH_HEADER,
        cookie,
      },
      payload: {
        topics: ["feeds/public/local", "server.example/note/#"],
      },
    });
    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json()).toEqual({
      topics: ["feeds/public/local", "server.example/note/#"],
    });
  });

  it("does not consume a stream ticket when principal authentication fails", async () => {
    const runtime = await buildApp();
    apps.push(runtime.app);

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { authorization: USER_AUTH_HEADER },
    });
    const cookie = getCookie(sessionResponse);

    const addResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: {
        authorization: USER_AUTH_HEADER,
        cookie,
      },
      payload: {
        topics: ["feeds/public/local"],
      },
    });
    expect(addResponse.statusCode).toBe(200);

    const unauthorizedStream = await runtime.app.inject({
      method: "GET",
      url: "/streaming/stream",
      headers: {
        accept: "text/event-stream",
        cookie,
      },
    });
    expect(unauthorizedStream.statusCode).toBe(401);

    const ticket = cookie.split("=")[1] ?? "";
    const session = await runtime.sessionStore.loadControlSession(ticket, PRINCIPAL);

    const streamPromise = runtime.app.inject({
      method: "GET",
      url: "/streaming/stream",
      headers: {
        accept: "text/event-stream",
        authorization: USER_AUTH_HEADER,
        cookie,
      },
    });

    setTimeout(() => {
      runtime.eventHub.publish({
        topic: "feeds/public/local",
        event: "activitypub",
        id: "evt-1",
        data: {
          topic: "feeds/public/local",
          payload: { id: "https://example.com/activities/1", type: "Create" },
        },
      });
      runtime.eventHub.closeSession(session.sessionId, "test-complete");
    }, 25);

    const streamResponse = await streamPromise;
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.payload).toContain("event: activitypub");
  });

  it("matches wildcard URI subscriptions and prevents ticket reuse", async () => {
    const runtime = await buildApp();
    apps.push(runtime.app);

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { authorization: USER_AUTH_HEADER },
    });
    const cookie = getCookie(sessionResponse);

    const addResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: {
        authorization: USER_AUTH_HEADER,
        cookie,
      },
      payload: {
        topics: ["server.example/note/#"],
      },
    });
    expect(addResponse.statusCode).toBe(200);

    const ticket = cookie.split("=")[1] ?? "";
    const session = await runtime.sessionStore.loadControlSession(ticket, PRINCIPAL);

    const streamPromise = runtime.app.inject({
      method: "GET",
      url: "/streaming/stream",
      headers: {
        accept: "text/event-stream",
        authorization: USER_AUTH_HEADER,
        cookie,
      },
    });

    setTimeout(() => {
      runtime.eventHub.publish({
        topic: "server.example/note/123",
        event: "activitypub",
        id: "evt-2",
        data: {
          topic: "server.example/note/123",
          payload: { id: "https://server.example/note/123", type: "Note" },
        },
      });
      runtime.eventHub.closeSession(session.sessionId, "test-complete");
    }, 25);

    const streamResponse = await streamPromise;
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.payload).toContain("\"topic\":\"server.example/note/123\"");

    const secondAttempt = await runtime.app.inject({
      method: "GET",
      url: "/streaming/stream",
      headers: {
        accept: "text/event-stream",
        authorization: USER_AUTH_HEADER,
        cookie,
      },
    });
    expect(secondAttempt.statusCode).toBe(409);
  });

  it("replays stored public events for Last-Event-ID reconnects", async () => {
    const runtime = await buildApp();
    apps.push(runtime.app);

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { authorization: USER_AUTH_HEADER },
    });
    const cookie = getCookie(sessionResponse);
    const ticket = cookie.split("=")[1] ?? "";

    const addResponse = await runtime.app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: {
        authorization: USER_AUTH_HEADER,
        cookie,
      },
      payload: {
        topics: ["feeds/public/local"],
      },
    });
    expect(addResponse.statusCode).toBe(200);

    const previous = await runtime.replayStore.append({
      topic: "feeds/public/local",
      event: "activitypub",
      data: {
        topic: "feeds/public/local",
        payload: { id: "https://example.com/activities/older", type: "Create" },
      },
    });
    const replayed = await runtime.replayStore.append({
      topic: "feeds/public/local",
      event: "activitypub",
      data: {
        topic: "feeds/public/local",
        payload: { id: "https://example.com/activities/newer", type: "Create" },
      },
    });
    expect(previous).not.toBeNull();
    expect(replayed).not.toBeNull();

    const session = await runtime.sessionStore.loadControlSession(ticket, PRINCIPAL);

    const streamPromise = runtime.app.inject({
      method: "GET",
      url: "/streaming/stream",
      headers: {
        accept: "text/event-stream",
        authorization: USER_AUTH_HEADER,
        cookie,
        "last-event-id": buildReplayEventId(previous?.sequence ?? 0),
      },
    });

    setTimeout(() => {
      runtime.eventHub.closeSession(session.sessionId, "test-complete");
    }, 25);

    const streamResponse = await streamPromise;
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.payload).toContain(`id: ${buildReplayEventId(replayed?.sequence ?? 0)}`);
    expect(streamResponse.payload).toContain("https://example.com/activities/newer");
  });
});
