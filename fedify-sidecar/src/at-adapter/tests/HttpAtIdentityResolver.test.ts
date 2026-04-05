import { describe, expect, it, vi } from "vitest";
import { HttpAtIdentityResolver } from "../ingress/HttpAtIdentityResolver.js";

describe("HttpAtIdentityResolver", () => {
  it("resolves a did:plc document and confirms the handle via DNS TXT", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://plc.directory/did%3Aplc%3Aalice");
      return jsonResponse({
        id: "did:plc:alice",
        alsoKnownAs: ["at://alice.example.com"],
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: "https://pds.example.com",
          },
        ],
      });
    });
    const resolveTxtImpl = vi.fn().mockResolvedValue([["did=did:plc:alice"]]);

    const resolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl,
    });

    const result = await resolver.resolveIdentity("did:plc:alice");

    expect(result).toEqual({
      success: true,
      handle: "alice.example.com",
      didDocument: expect.objectContaining({
        id: "did:plc:alice",
      }),
    });
    expect(resolveTxtImpl).toHaveBeenCalledWith("_atproto.alice.example.com");
  });

  it("marks the handle invalid when bidirectional resolution does not confirm it", async () => {
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        id: "did:plc:alice",
        alsoKnownAs: ["at://alice.example.com"],
      });
    });
    const resolveTxtImpl = vi.fn().mockResolvedValue([["did=did:plc:someone-else"]]);

    const resolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl,
    });

    const result = await resolver.resolveIdentity("did:plc:alice");

    expect(result.success).toBe(true);
    expect(result.handle).toBe("handle.invalid");
  });

  it("supports did:web localhost resolution and well-known handle fallback", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://localhost:3000/.well-known/did.json") {
        return jsonResponse({
          id: "did:web:localhost%3A3000",
          alsoKnownAs: ["at://alice.localhost"],
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "http://localhost:3000",
            },
          ],
        });
      }
      if (url === "https://alice.localhost/.well-known/atproto-did") {
        return textResponse("did:web:localhost%3A3000");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const resolveTxtImpl = vi.fn().mockRejectedValue(new Error("no TXT"));

    const resolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl,
    });

    const result = await resolver.resolveIdentity("did:web:localhost%3A3000");

    expect(result.success).toBe(true);
    expect(result.handle).toBe("alice.localhost");
  });

  it("resolves path-form did:web identifiers via /<path>/did.json", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/user/alice/did.json") {
        return jsonResponse({
          id: "did:web:example.com:user:alice",
          alsoKnownAs: ["at://alice.example.com"],
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example.com",
            },
          ],
        });
      }
      if (url === "https://alice.example.com/.well-known/atproto-did") {
        return textResponse("did:web:example.com:user:alice");
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const resolveTxtImpl = vi.fn().mockRejectedValue(new Error("no TXT"));

    const resolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl,
    });

    const result = await resolver.resolveIdentity("did:web:example.com:user:alice");

    expect(result.success).toBe(true);
    expect(result.handle).toBe("alice.example.com");
  });

  it("reuses cached DID documents within the configured TTL", async () => {
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        id: "did:plc:alice",
        alsoKnownAs: ["at://alice.example.com"],
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: "https://pds.example.com",
          },
        ],
      });
    });
    const resolveTxtImpl = vi.fn().mockResolvedValue([[("did=did:plc:alice")]]);

    const resolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTxtImpl,
      didDocumentCacheTtlMs: 60_000,
    });

    const first = await resolver.resolveDocument("did:plc:alice");
    const second = await resolver.resolveDocument("did:plc:alice");

    expect(first.did).toBe("did:plc:alice");
    expect(second.did).toBe("did:plc:alice");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses failed DID resolutions within the configured TTL", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const resolver = new HttpAtIdentityResolver({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 1,
      failedResolutionCacheTtlMs: 60_000,
    });

    await expect(resolver.resolveDocument("did:web:prod-chi0.stream.place")).rejects.toThrow(
      "Network error while requesting https://prod-chi0.stream.place/.well-known/did.json",
    );
    await expect(resolver.resolveDocument("did:web:prod-chi0.stream.place")).rejects.toThrow(
      "Network error while requesting https://prod-chi0.stream.place/.well-known/did.json",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(JSON.stringify(body), "utf8").toString(),
    },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain",
      "content-length": Buffer.byteLength(body, "utf8").toString(),
    },
  });
}
