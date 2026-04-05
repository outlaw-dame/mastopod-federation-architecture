import { importJWK, jwtVerify } from 'jose';
import type { AtSessionContext } from '../auth/AtSessionTypes.js';
import type { OAuthTokenPayload, OAuthTokenVerifyResult } from './OAuthTypes.js';
import { OAuthAsKeyManager } from './OAuthAsKeyManager.js';
import { DpopVerifier } from './DpopVerifier.js';

function splitScope(scope: string): string[] {
  return scope.split(/\s+/g).map((item) => item.trim()).filter(Boolean);
}

export interface OAuthTokenVerifierDeps {
  issuer: string;
  resourceServerOrigin: string;
  keyManager: OAuthAsKeyManager;
  dpopVerifier: DpopVerifier;
  nonceFactory: () => Promise<string>;
}

export interface OAuthAccessTokenVerifier {
  verify(
    authHeader: string | undefined,
    dpopHeader: string | undefined,
    method: string,
    htu: string,
  ): Promise<OAuthTokenVerifyResult>;
}

export class OAuthTokenVerifier implements OAuthAccessTokenVerifier {
  constructor(private readonly deps: OAuthTokenVerifierDeps) {}

  async verify(
    authHeader: string | undefined,
    dpopHeader: string | undefined,
    method: string,
    htu: string,
  ): Promise<OAuthTokenVerifyResult> {
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!bearer) {
      return { session: null, errorCode: 'invalid_token' };
    }

    let payload: OAuthTokenPayload;
    try {
      const publicJwk = await this.deps.keyManager.getPublicJwk();
      const { payload: verified } = await jwtVerify(bearer, await importJWK(publicJwk, 'ES256'), {
        issuer: this.deps.issuer,
        audience: this.deps.resourceServerOrigin,
        algorithms: ['ES256'],
      });
      payload = verified as unknown as OAuthTokenPayload;
    } catch {
      return { session: null, errorCode: 'invalid_token' };
    }

    if (payload.token_use !== 'access') {
      return { session: null, errorCode: 'invalid_token' };
    }

    if (typeof payload.sub !== 'string' || !payload.sub.startsWith('did:')) {
      return { session: null, errorCode: 'invalid_token' };
    }

    if (typeof payload.grant_id !== 'string' || payload.grant_id.trim().length === 0) {
      return { session: null, errorCode: 'invalid_token' };
    }

    const scope = typeof payload.scope === 'string' ? payload.scope : '';
    const scopeList = splitScope(scope);
    if (!scopeList.includes('atproto')) {
      return { session: null, errorCode: 'insufficient_scope' };
    }

    if (!dpopHeader) {
      return { session: null, errorCode: 'invalid_dpop_proof' };
    }

    let dpopJkt = '';
    try {
      const dpop = await this.deps.dpopVerifier.verify({
        proofJwt: dpopHeader,
        htm: method,
        htu,
        accessToken: bearer,
      });
      dpopJkt = dpop.jkt;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid_dpop_proof';
      if (message === 'use_dpop_nonce') {
        return {
          session: null,
          errorCode: 'use_dpop_nonce',
          nonce: await this.deps.nonceFactory(),
        };
      }
      return { session: null, errorCode: 'invalid_dpop_proof' };
    }

    if (!payload.cnf?.jkt) {
      return { session: null, errorCode: 'invalid_token' };
    }

    if (payload.cnf.jkt !== dpopJkt) {
      return { session: null, errorCode: 'invalid_dpop_proof' };
    }

    const session: AtSessionContext = {
      canonicalAccountId: typeof payload.act === 'string' ? payload.act : payload.sub,
      did: payload.sub,
      handle: payload.sub,
      scope: scopeList.includes('transition:generic') ? 'app_password_restricted' : 'full',
      tokenId: payload.jti,
      sessionFamilyId: payload.grant_id,
    };

    return { session };
  }
}
