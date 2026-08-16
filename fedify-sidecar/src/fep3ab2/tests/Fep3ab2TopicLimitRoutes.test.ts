import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFep3ab2Routes } from "../Fep3ab2FastifyRoutes.js";
import { Fep3ab2EventHub } from "../Fep3ab2EventHub.js";
import { Fep3ab2ReplayStore } from "../Fep3ab2ReplayStore.js";
import { Fep3ab2SessionStore } from "../Fep3ab2SessionStore.js";
import { MemoryRedis } from "./MemoryRedis.js";

const PRINCIPAL = "https://example.com/users/alice";
const AUTHORIZATION = "Bearer user-auth-token";

function getCookie(response: { headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value) {
    throw new Error("missing set-cookie header");
  }
  return value.split(";")[0] ?? value;
}

describe("FEP-3ab2 session topic admission", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()?.close();
    }
  });

  it("returns the session-store 409 when cumulative authorized topics exceed the cap", async () => {
    const app = Fastify();
    apps.push(app);
    const redis = new MemoryRedis();
    const sessionStore = new Fep3ab2SessionStore(redis as any, {
      ticketSecret: "test-secret",
      ticketTtlSec: 300,
      maxTopicsPerSession: 2,
    });
    const eventHub = new Fep3ab2EventHub(60_000);
    const replayStore = new Fep3ab2ReplayStore(redis as any, {
      prefix: "topic-limit-route-test",
      ttlSec: 300,
      maxReplayEvents: 50,
    });
    const authorityClient = {
      resolvePrincipal: vi.fn(async () => ({ principal: PRINCIPAL })),
      authorizeTopics: vi.fn(async (_principal: string, topics: string[]) => ({
        allowedTopics: topics,
        deniedTopics: [],
      })),
    };

    registerFep3ab2Routes(app, {
      authorityClient: authorityClient as any,
      sessionStore,
      eventHub,
      replayStore,
      cookieSecure: false,
    });
    await app.ready();

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { authorization: AUTHORIZATION },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const cookie = getCookie(sessionResponse);

    const fillResponse = await app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: { authorization: AUTHORIZATION, cookie },
      payload: { topics: ["feeds/public/local", "feeds/public/remote"] },
    });
    expect(fillResponse.statusCode).toBe(200);

    const overflowResponse = await app.inject({
      method: "POST",
      url: "/streaming/control/subscriptions",
      headers: { authorization: AUTHORIZATION, cookie },
      payload: { topics: ["feeds/public/unified"] },
    });

    expect(overflowResponse.statusCode).toBe(409);
    expect(overflowResponse.json()).toMatchObject({
      error: "topic_limit_exceeded",
      retryable: false,
    });
    expect(authorityClient.authorizeTopics).toHaveBeenCalledTimes(2);
  });
});
