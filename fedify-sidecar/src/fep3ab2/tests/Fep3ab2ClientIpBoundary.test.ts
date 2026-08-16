import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installFep3ab2ClientIpBoundary } from "../Fep3ab2ClientIpBoundary.js";

describe("installFep3ab2ClientIpBoundary", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it("overwrites caller-controlled X-Forwarded-For on FEP routes", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    apps.push(app);
    installFep3ab2ClientIpBoundary(app, () => "203.0.113.44");
    app.post("/streaming/control", async (request) => ({
      forwardedFor: request.headers["x-forwarded-for"],
    }));

    const response = await app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { "x-forwarded-for": "198.51.100.10, 192.0.2.7" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ forwardedFor: "203.0.113.44" });
  });

  it("also protects subscription and stream paths while leaving unrelated routes untouched", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    apps.push(app);
    installFep3ab2ClientIpBoundary(app, () => "203.0.113.44");
    const echo = async (request: any) => ({ forwardedFor: request.headers["x-forwarded-for"] });
    app.get("/streaming/control/subscriptions", echo);
    app.get("/streaming/stream", echo);
    app.get("/health", echo);

    const headers = { "x-forwarded-for": "198.51.100.99" };
    const subscriptions = await app.inject({
      method: "GET",
      url: "/streaming/control/subscriptions?topic=feeds/public/local",
      headers,
    });
    const stream = await app.inject({ method: "GET", url: "/streaming/stream", headers });
    const health = await app.inject({ method: "GET", url: "/health", headers });

    expect(subscriptions.json()).toEqual({ forwardedFor: "203.0.113.44" });
    expect(stream.json()).toEqual({ forwardedFor: "203.0.113.44" });
    expect(health.json()).toEqual({ forwardedFor: "198.51.100.99" });
  });

  it("removes spoofed forwarded metadata when no socket identity can be resolved", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    apps.push(app);
    installFep3ab2ClientIpBoundary(app, () => "unknown");
    app.post("/streaming/control", async (request) => ({
      hasForwardedFor: request.headers["x-forwarded-for"] !== undefined,
    }));

    const response = await app.inject({
      method: "POST",
      url: "/streaming/control",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hasForwardedFor: false });
  });
});
