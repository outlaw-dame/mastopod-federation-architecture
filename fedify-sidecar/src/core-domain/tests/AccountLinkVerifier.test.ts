import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountLinkVerifier } from "../services/AccountLinkVerifier.js";
import type { IdentityBinding } from "../identity/IdentityBinding.js";

const BASE_BINDING: IdentityBinding = {
  canonicalAccountId: "acct:alice@example.com",
  contextId: "default",
  webId: "https://alice.example.com/profile/card#me",
  activityPubActorUri: "https://alice.example.com/users/alice",
  atprotoDid: "did:plc:alice123",
  atprotoHandle: "alice.example.com",
  canonicalDidMethod: "did:plc",
  atprotoPdsEndpoint: "https://atproto.example.com",
  apSigningKeyRef: "ap-key",
  atSigningKeyRef: "at-signing-key",
  atRotationKeyRef: "at-rotation-key",
  plc: {
    opCid: "bafy-op",
    rotationKeyRef: "at-rotation-key",
    plcUpdateState: "CONFIRMED",
    lastSubmittedAt: null,
    lastConfirmedAt: null,
    lastError: null,
  },
  didWeb: null,
  accountLinks: {
    apAlsoKnownAs: [],
    atAlsoKnownAs: [],
    relMe: [],
    webIdSameAs: [],
    webIdAccounts: [],
  },
  status: "active",
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z",
};

describe("AccountLinkVerifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns fresh_verified when AP, DID, and WebID all match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === BASE_BINDING.activityPubActorUri) {
          return jsonResponse({
            alsoKnownAs: [`at://${BASE_BINDING.atprotoDid}`],
          });
        }
        if (url === `https://plc.directory/${BASE_BINDING.atprotoDid}`) {
          return jsonResponse({
            operation: {
              alsoKnownAs: [`at://${BASE_BINDING.atprotoHandle}`, BASE_BINDING.activityPubActorUri],
            },
          });
        }
        if (url === BASE_BINDING.webId) {
          return jsonResponse({
            sameAs: [BASE_BINDING.activityPubActorUri, `at://${BASE_BINDING.atprotoDid}`],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch,
    );

    const verifier = new AccountLinkVerifier();
    const result = await verifier.verifyAccountLink(BASE_BINDING);

    expect(result.status).toBe("fresh_verified");
    expect(result.actorDocumentVerified).toBe(true);
    expect(result.didDocumentVerified).toBe(true);
    expect(result.webIdDocumentVerified).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns conflict when the AP actor points at a different DID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === BASE_BINDING.activityPubActorUri) {
          return jsonResponse({
            alsoKnownAs: ["at://did:plc:someone-else"],
          });
        }
        if (url === `https://plc.directory/${BASE_BINDING.atprotoDid}`) {
          return jsonResponse({
            operation: {
              alsoKnownAs: [`at://${BASE_BINDING.atprotoHandle}`, BASE_BINDING.activityPubActorUri],
            },
          });
        }
        if (url === BASE_BINDING.webId) {
          return jsonResponse({
            sameAs: [BASE_BINDING.activityPubActorUri, `at://${BASE_BINDING.atprotoDid}`],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch,
    );

    const verifier = new AccountLinkVerifier();
    const result = await verifier.verifyAccountLink(BASE_BINDING);

    expect(result.status).toBe("conflict");
    expect(result.actorDocumentVerified).toBe(false);
    expect(result.errors).toContain("ActivityPub actor links to a different ATProto identity");
  });

  it("supports did:web resolution without hardcoding plc.directory", async () => {
    const binding: IdentityBinding = {
      ...BASE_BINDING,
      atprotoDid: "did:web:alice.example.com",
      canonicalDidMethod: "did:web",
      plc: null,
      didWeb: {
        hostname: "alice.example.com",
        documentPath: "/.well-known/did.json",
        lastRenderedAt: null,
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === binding.activityPubActorUri) {
          return jsonResponse({
            alsoKnownAs: [`at://${binding.atprotoDid}`],
          });
        }
        if (url === "https://alice.example.com/.well-known/did.json") {
          return jsonResponse({
            alsoKnownAs: [`at://${binding.atprotoHandle}`, binding.activityPubActorUri],
          });
        }
        if (url === binding.webId) {
          return jsonResponse({
            sameAs: [binding.activityPubActorUri, `at://${binding.atprotoDid}`],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch,
    );

    const verifier = new AccountLinkVerifier();
    const result = await verifier.verifyAccountLink(binding);

    expect(result.status).toBe("fresh_verified");
    expect(result.didDocumentVerified).toBe(true);
  });
});

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
