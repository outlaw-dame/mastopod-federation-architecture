vi.mock("../utils/logger.js", () => {
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
  injectMutedProperty,
  registerMutedCollectionRoutes,
} from "./MutedCollectionFastifyBridge.js";

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

describe("MutedCollectionFastifyBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects the muted collection URL into actor documents", () => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://fed.example.com/users/alice",
      type: "Person",
    });

    const injected = JSON.parse(injectMutedProperty("/users/alice", body, "fed.example.com"));

    expect(injected.muted).toBe("https://fed.example.com/users/alice/muted");
    expect(injected["@context"]).toEqual([
      "https://www.w3.org/ns/activitystreams",
      {
        apods: "http://activitypods.org/ns/core#",
        muted: {
          "@id": "apods:muted",
          "@type": "@id",
        },
        mutedOf: {
          "@id": "apods:mutedOf",
          "@type": "@id",
        },
        subjectCanonicalId: "apods:subjectCanonicalId",
        subjectProtocol: "apods:subjectProtocol",
      },
    ]);
  });

  it("serves the muted collection with owner-only signature auth", async () => {
    const actorUri = "https://fed.example.com/users/alice";
    const keyId = `${actorUri}#main-key`;
    const date = "Sun, 19 Apr 2026 15:10:00 GMT";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = Fastify({ logger: false });

    registerMutedCollectionRoutes(app, {
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
            {
              type: "Object",
              subjectCanonicalId: "did:plc:alicefriend",
              subjectProtocol: "atproto",
              id: "did:plc:alicefriend",
              published: "2026-04-19T12:00:00Z",
            },
            {
              type: "Object",
              subjectCanonicalId: "@carol@example.net",
              subjectProtocol: "activitypub",
              published: "2026-04-18T12:00:00Z",
            },
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
      url: "/users/alice/muted",
      headers: {
        date,
        signature: createSignatureHeader({
          method: "GET",
          path: "/users/alice/muted",
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
        {
          apods: "http://activitypods.org/ns/core#",
          muted: {
            "@id": "apods:muted",
            "@type": "@id",
          },
          mutedOf: {
            "@id": "apods:mutedOf",
            "@type": "@id",
          },
          subjectCanonicalId: "apods:subjectCanonicalId",
          subjectProtocol: "apods:subjectProtocol",
        },
      ],
      type: "OrderedCollection",
      id: "https://fed.example.com/users/alice/muted",
      attributedTo: actorUri,
      mutedOf: actorUri,
      totalItems: 2,
      orderedItems: [
        {
          type: "Object",
          subjectCanonicalId: "did:plc:alicefriend",
          subjectProtocol: "atproto",
          id: "did:plc:alicefriend",
          published: "2026-04-19T12:00:00Z",
        },
        {
          type: "Object",
          subjectCanonicalId: "@carol@example.net",
          subjectProtocol: "activitypub",
          published: "2026-04-18T12:00:00Z",
        },
      ],
    });

    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe(
      "http://activitypods.internal/api/internal/followers-sync/muted-collection?actorIdentifier=alice",
    );

    await app.close();
  });

  it("serves a public muted collection without requiring an HTTP signature", async () => {
    const app = Fastify({ logger: false });

    registerMutedCollectionRoutes(app, {
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
          {
            type: "Object",
            subjectCanonicalId: "https://remote.example/users/noisy",
            subjectProtocol: "activitypub",
            id: "https://remote.example/users/noisy",
            published: "2026-04-19T12:00:00Z",
          },
        ],
        public: true,
        followersCollection: "https://fed.example.com/users/alice/muted/followers",
      }),
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/users/alice/muted",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        {
          apods: "http://activitypods.org/ns/core#",
          muted: {
            "@id": "apods:muted",
            "@type": "@id",
          },
          mutedOf: {
            "@id": "apods:mutedOf",
            "@type": "@id",
          },
          subjectCanonicalId: "apods:subjectCanonicalId",
          subjectProtocol: "apods:subjectProtocol",
        },
      ],
      type: "OrderedCollection",
      id: "https://fed.example.com/users/alice/muted",
      attributedTo: "https://fed.example.com/users/alice",
      mutedOf: "https://fed.example.com/users/alice",
      followers: "https://fed.example.com/users/alice/muted/followers",
      totalItems: 1,
      orderedItems: [
        {
          type: "Object",
          subjectCanonicalId: "https://remote.example/users/noisy",
          subjectProtocol: "activitypub",
          id: "https://remote.example/users/noisy",
          published: "2026-04-19T12:00:00Z",
        },
      ],
    });

    await app.close();
  });

  it("serves the public muted followers collection", async () => {
    const app = Fastify({ logger: false });

    registerMutedCollectionRoutes(app, {
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
        followersCollection: "https://fed.example.com/users/alice/muted/followers",
      }),
    } as never);

    const response = await app.inject({
      method: "GET",
      url: "/users/alice/muted/followers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        {
          apods: "http://activitypods.org/ns/core#",
          muted: {
            "@id": "apods:muted",
            "@type": "@id",
          },
          mutedOf: {
            "@id": "apods:mutedOf",
            "@type": "@id",
          },
          subjectCanonicalId: "apods:subjectCanonicalId",
          subjectProtocol: "apods:subjectProtocol",
        },
      ],
      type: "Collection",
      id: "https://fed.example.com/users/alice/muted/followers",
      attributedTo: "https://fed.example.com/users/alice",
      totalItems: 2,
      items: [
        "https://remote.example/users/observer",
        "https://remote.example/users/ally",
      ],
    });

    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe(
      "http://activitypods.internal/api/internal/followers-sync/muted-followers-collection?actorIdentifier=alice",
    );

    await app.close();
  });
});
