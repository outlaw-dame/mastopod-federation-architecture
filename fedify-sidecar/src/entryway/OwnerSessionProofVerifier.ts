import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { EntrywayError } from "./errors.js";
import type { AccountRoute, EntrywayProviderDefinition } from "./types.js";

const PURPOSE = "paper.entryway.owner-session.v1";
const DEFAULT_AUDIENCE = "urn:paper:entryway:owner-session:v1";

export interface OwnerSessionProofInput {
  proof: string | undefined;
  provider: EntrywayProviderDefinition;
  route: AccountRoute;
}

export interface VerifiedOwnerSessionProof {
  jti: string;
}

export interface EntrywayOwnerSessionProofVerifier {
  verify(input: OwnerSessionProofInput): Promise<VerifiedOwnerSessionProof>;
}

export class ProviderJwksOwnerSessionProofVerifier implements EntrywayOwnerSessionProofVerifier {
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  public constructor(
    private readonly keySetFactory: (url: URL) => JWTVerifyGetKey = (url) => createRemoteJWKSet(url, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 5 * 60_000,
    }),
  ) {}

  public async verify(input: OwnerSessionProofInput): Promise<VerifiedOwnerSessionProof> {
    const { proof, provider, route } = input;
    const issuer = provider.ownerSessionIssuer;
    const jwksUrl = provider.ownerSessionJwksUrl;
    const audience = provider.ownerSessionAudience || DEFAULT_AUDIENCE;
    if (typeof proof !== "string" || !proof || proof.length > 8192 || !issuer || !jwksUrl) {
      throw invalid();
    }
    try {
      let keys = this.keySets.get(jwksUrl);
      if (!keys) {
        keys = this.keySetFactory(new URL(jwksUrl));
        this.keySets.set(jwksUrl, keys);
      }
      const { payload, protectedHeader } = await jwtVerify(proof, keys, {
        issuer,
        audience,
        algorithms: ["ES256"],
        clockTolerance: 5,
        maxTokenAge: "5 minutes",
        requiredClaims: ["sub", "jti", "iat", "exp"],
      });
      if (protectedHeader.typ !== "JWT" || payload["purpose"] !== PURPOSE ||
          payload.sub !== route.webId || payload["webid"] !== route.webId ||
          payload["account_id"] !== route.accountId ||
          payload["username"] !== route.username ||
          payload["app_client_id"] !== provider.appClientId ||
          typeof payload.jti !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(payload.jti)) {
        throw invalid();
      }
      return { jti: payload.jti };
    } catch (error) {
      if (error instanceof EntrywayError) throw error;
      throw invalid();
    }
  }
}

function invalid(): EntrywayError {
  return new EntrywayError("owner_session_proof_invalid", "Fresh Solid-OIDC owner authentication is required", {
    statusCode: 401,
    retryable: false,
  });
}
