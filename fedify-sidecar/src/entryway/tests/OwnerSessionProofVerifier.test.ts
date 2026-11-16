import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  ProviderJwksOwnerSessionProofVerifier,
} from "../OwnerSessionProofVerifier.js";
import type { AccountRoute, EntrywayProviderDefinition } from "../types.js";

const issuer = "https://pods.example.org";
const audience = "urn:paper:entryway:owner-session:v1";
const appClientId = "https://memory.example.org/app";
const route = {
  accountId: "acct_11111111-1111-4111-8111-111111111111",
  username: "alice",
  webId: "https://pods.example.org/alice/profile/card#me",
} as AccountRoute;
const provider = {
  providerId: "pods",
  baseUrl: issuer,
  provisioningBearerToken: "not-used",
  appClientId,
  ownerSessionIssuer: issuer,
  ownerSessionJwksUrl: `${issuer}/.well-known/jwks.json`,
  ownerSessionAudience: audience,
} as EntrywayProviderDefinition;

describe("provider-signed Solid-OIDC owner-session proof", () => {
  it("accepts one exact, fresh account/app/route-bound ES256 proof", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    jwk.alg = "ES256";
    const keys = createLocalJWKSet({ keys: [jwk] });
    const verifier = new ProviderJwksOwnerSessionProofVerifier(() => keys);
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const proof = await new SignJWT({
      purpose: "paper.entryway.owner-session.v1",
      account_id: route.accountId,
      username: route.username,
      webid: route.webId,
      app_client_id: appClientId,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(issuer).setAudience(audience).setSubject(route.webId)
      .setJti(jti).setIssuedAt(now).setExpirationTime(now + 90)
      .sign(privateKey);

    await expect(verifier.verify({ proof, provider, route }))
      .resolves.toEqual({ jti, expiresAt: new Date((now + 90) * 1_000).toISOString() });
    await expect(verifier.verify({
      proof, provider, route: { ...route, accountId: "acct_22222222-2222-4222-8222-222222222222" },
    })).rejects.toMatchObject({ code: "owner_session_proof_invalid", statusCode: 401 });
  });

  it("fails closed without pinned issuer/JWKS", async () => {
    const verifier = new ProviderJwksOwnerSessionProofVerifier(() => {
      throw new Error("must not resolve unpinned keys");
    });
    await expect(verifier.verify({ proof: "x".repeat(100), provider: {
      ...provider, ownerSessionJwksUrl: undefined,
    }, route })).rejects.toMatchObject({ code: "owner_session_proof_invalid" });
  });

  it("rejects a proof whose signed lifetime exceeds the provider contract", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    jwk.alg = "ES256";
    const verifier = new ProviderJwksOwnerSessionProofVerifier(() => createLocalJWKSet({ keys: [jwk] }));
    const now = Math.floor(Date.now() / 1000);
    const proof = await new SignJWT({
      purpose: "paper.entryway.owner-session.v1", account_id: route.accountId,
      username: route.username, webid: route.webId, app_client_id: appClientId,
    }).setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(issuer).setAudience(audience).setSubject(route.webId)
      .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 181)
      .sign(privateKey);
    await expect(verifier.verify({ proof, provider, route }))
      .rejects.toMatchObject({ code: "owner_session_proof_invalid" });
  });
});
