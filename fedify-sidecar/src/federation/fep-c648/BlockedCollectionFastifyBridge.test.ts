vi.mock("../../utils/logger.js", () => {
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  return { logger, default: logger };
});

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "undici";
import {
  injectBlockedProperty,
  registerBlockedCollectionRoutes,
} from "./BlockedCollectionFastifyBridge.js";

function makeJsonBody(value: unknown) {
  const payload = JSON.stringify(value);
  return {
    json: async () => value,
    text: async () => payload,
  };
}

function createSignatureHeader(input: {
  method: string;
  path: string;
  date: string;
  keyId: string;
  privateKey: KeyObject;
}): string {
  const signedHeaders = "(request-target) date";
  const signingString =
    `(request-target): ${input.method.toLowerCase()} ${input.path}\n` +
    `date: ${input.date}`;
  const signature = createSign("RSA-SHA256")
    .update(signingString)
    .sign(input.privateKey, "base64");

  return `keyId="${input.keyId}",headers="${signedHeaders}",signature="${signature}"`;
}

describe("BlockedCollectionFastifyBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects blocked and blocks collection URLs into actor documents", () => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://fed.example.com/users/alice",
      type: "Person",
    });

    const injected = JSON.parse(injectBlockedProperty("/users/alice", body, "fed.example.com"));

    expect(injected.blocked).toBe("https://fed.example.com/users/alice/blocked");
    expect(injected.blocks).toBe("https://fed.example.com/users/alice/blocks");
    expect(injected["@context"]).toEqual([
      "https://www.w3.org/ns/activitystreams",
      "https://purl.archive.org/socialweb/blocked",
    ]);
  });

  it("serves the blocked collection with blockedOf metadata and the correct internal route", async () => {
    const actorUri = "https://fed.example.com/users/alice";
    const keyId = `${actorUri}#main-key`;
    const date = "Sun, 19 Apr 2026 15:00:00 GMT";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = Fastify({ logger: false });

    registerBlockedCollectionRoutes(app, {
      activityPodsUrl: "http://activitypods.internal",
      activityPodsToken: "secret-token",
      domain: "fed.example.com",
      userAgent: "Fedify-Test/1.0",
      requestTimeoutMs: 1000,
    });

    vi.mocked(request)
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: makeJsonBody({
          items: [
            "https://remote.example/users/spammer",
            "https://remote.example/users/spammer",
            { id: "https://remote.example/users/noisy" },
          ],
          public: false,
          followersCollection: null,
        }),
      } as never)
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: makeJsonBody({
          id: actorUri,
          publicKey: {
            id: keyId,
            owner: actorUri,
            publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        }),
      } as never);

    const response = await app.inject({
      method: "GET",
      url: "/users/alice/blocked",
      headers: {
        date,
        signature: createSignatureHeader({
          method: "GET",
          path: "/users/alice/blocked",
          date,
          keyId,
          privateKey,
        }),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/activity+json");
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://purl.archive.org/socialweb/blocked",
      ],
      type: "OrderedCollection",
      id: "https://fed.example.com/users/alice/blocked",
      attributedTo: actorUri,
      blockedOf: actorUri,
      totalItems: 2,
      orderedItems: [
        "https://remote.example/users/spammer",
        "https://remote.example/users/noisy",
      ],
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe(
      "http://activitypods.internal/api/internal/followers-sync/blocked-collection?actorIdentifier=alice",
    );

    await app.close();
  });

  it("serves a public blocked collection without requiring an HTTP signature", async () => {
    const app = Fastify({ logger: false });

    registerBlockedCollectionRoutes(app, {
      activityPodsUrl: "http://activitypods.internal",
      activityPodsToken: "secret-token",
      domain: "fed.example.com",
      requestTimeoutMs: 1000,
    });

    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: makeJsonBody({
        items: [
          "https://remote.example/users/spammer",
          { id: "https://remote.example/users/noisy" },
        ],
        public: true,
        followersCollection: "https://fed.example.com/users/alice/blocked/followers",
      }),
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/users/alice/blocked",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://purl.archive.org/socialweb/blocked",
      ],
      type: "OrderedCollection",
      id: "https://fed.example.com/users/alice/blocked",
      attributedTo: "https://fed.example.com/users/alice",
      blockedOf: "https://fed.example.com/users/alice",
      followers: "https://fed.example.com/users/alice/blocked/followers",
      totalItems: 2,
      orderedItems: [
        "https://remote.example/users/spammer",
        "https://remote.example/users/noisy",
      ],
    });
    expect(request).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("serves the public blocked followers collection", async () => {
    const app = Fastify({ logger: false });

    registerBlockedCollectionRoutes(app, {
      activityPodsUrl: "http://activitypods.internal",
      activityPodsToken: "secret-token",
      domain: "fed.example.com",
      requestTimeoutMs: 1000,
    });

    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: makeJsonBody({
        items: [
          "https://remote.example/users/observer",
          { id: "https://remote.example/users/ally" },
          "https://remote.example/users/observer",
        ],
        public: true,
        followersCollection: "https://fed.example.com/users/alice/blocked/followers",
      }),
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/users/alice/blocked/followers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://purl.archive.org/socialweb/blocked",
      ],
      type: "Collection",
      id: "https://fed.example.com/users/alice/blocked/followers",
      attributedTo: "https://fed.example.com/users/alice",
      totalItems: 2,
      items: [
        "https://remote.example/users/observer",
        "https://remote.example/users/ally",
      ],
    });
    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe(
      "http://activitypods.internal/api/internal/followers-sync/blocked-followers-collection?actorIdentifier=alice",
    );

    await app.close();
  });

  it("serves the blocks collection with blocksOf metadata and sanitized block activities", async () => {
    const actorUri = "https://fed.example.com/users/alice";
    const keyId = `${actorUri}#main-key`;
    const date = "Sun, 19 Apr 2026 15:05:00 GMT";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = Fastify({ logger: false });

    registerBlockedCollectionRoutes(app, {
      activityPodsUrl: "http://activitypods.internal",
      activityPodsToken: "secret-token",
      domain: "fed.example.com",
      userAgent: "Fedify-Test/1.0",
      requestTimeoutMs: 1000,
    });

    vi.mocked(request)
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: makeJsonBody({
          id: actorUri,
          publicKey: {
            id: keyId,
            owner: actorUri,
            publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        }),
      } as never)
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: makeJsonBody({
          items: [
            {
              id: "https://fed.example.com/activities/block-1",
              type: "Block",
              object: {
                id: "https://remote.example/users/spammer",
                type: "Person",
                name: "Irritating Spammer",
                preferredUsername: "ignore-me",
              },
              published: "2026-04-18T12:00:00Z",
              extra: "drop-me",
            },
            {
              id: "https://fed.example.com/activities/ignore-me",
              type: "Create",
              object: "https://remote.example/notes/1",
            },
          ],
        }),
      } as never);

    const response = await app.inject({
      method: "GET",
      url: "/users/alice/blocks",
      headers: {
        date,
        signature: createSignatureHeader({
          method: "GET",
          path: "/users/alice/blocks",
          date,
          keyId,
          privateKey,
        }),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://purl.archive.org/socialweb/blocked",
      ],
      type: "OrderedCollection",
      id: "https://fed.example.com/users/alice/blocks",
      attributedTo: actorUri,
      blocksOf: actorUri,
      totalItems: 1,
      orderedItems: [
        {
          id: "https://fed.example.com/activities/block-1",
          type: "Block",
          object: {
            id: "https://remote.example/users/spammer",
            type: "Person",
            name: "Irritating Spammer",
          },
          published: "2026-04-18T12:00:00Z",
        },
      ],
    });

    expect(vi.mocked(request).mock.calls[1]?.[0]).toBe(
      "http://activitypods.internal/api/internal/followers-sync/blocks-collection?actorIdentifier=alice",
    );

    await app.close();
  });
});
