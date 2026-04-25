vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

import Fastify from "fastify";
import { MemoryKvStore } from "@fedify/fedify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFedifyRoutes } from "../FedifyFastifyBridge.js";
import { createFedifyAdapter } from "../FedifyFederationAdapter.js";

describe("FedifyFederationAdapter collections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves synthetic collection endpoints for known local actors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "http://activitypods.internal/api/internal/actors/alice") {
        return new Response(
          JSON.stringify({
            id: "https://fed.example.com/users/alice",
            name: "Alice",
            url: "https://fed.example.com/users/alice",
            publicKeyPem: [
              "-----BEGIN PUBLIC KEY-----",
              "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAM9G4Aq8v4hWn9n8j6Yf+9+7VYzW4x7K",
              "kDNo1m0Zr9+fJwJ0+5t6sVZ/8nk6uZ8P8J6j4D0KXy9h7x7vI7P7w1UCAwEAAQ==",
              "-----END PUBLIC KEY-----",
            ].join("\n"),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const adapter = createFedifyAdapter(new MemoryKvStore(), {
      domain: "fed.example.com",
      activityPodsUrl: "http://activitypods.internal",
      activityPodsToken: "test-token",
    });

    const app = Fastify({ logger: false, trustProxy: true });
    registerFedifyRoutes(app, adapter);

    const actorResponse = await app.inject({
      method: "GET",
      url: "/users/alice",
      headers: {
        accept: "application/activity+json",
        host: "fed.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(actorResponse.statusCode).toBe(200);

    const actor = actorResponse.json() as Record<string, unknown>;
    expect(actor["outbox"]).toBe("https://fed.example.com/users/alice/outbox");
    expect(actor["followers"]).toBe("https://fed.example.com/users/alice/followers");
    expect(actor["following"]).toBe("https://fed.example.com/users/alice/following");
    expect(actor["featured"]).toBe("https://fed.example.com/users/alice/featured");
    expect(actor["featuredTags"]).toBe("https://fed.example.com/users/alice/featuredTags");

    for (const path of [
      "/users/alice/outbox",
      "/users/alice/followers",
      "/users/alice/following",
      "/users/alice/featured",
      "/users/alice/featuredTags",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: {
          accept: "application/activity+json",
          host: "fed.example.com",
          "x-forwarded-proto": "https",
        },
      });
      expect(response.statusCode).toBe(200);
      const collection = response.json() as Record<string, unknown>;
      expect(String(collection["type"] ?? "")).toContain("Collection");
    }

    expect(fetchSpy).toHaveBeenCalled();
    await app.close();
  });
});
