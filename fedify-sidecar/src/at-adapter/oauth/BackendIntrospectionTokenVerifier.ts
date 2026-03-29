import { setTimeout as delay } from 'node:timers/promises';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { AtSessionContext } from '../auth/AtSessionTypes.js';
import { DpopVerifier } from './DpopVerifier.js';
import type { OAuthTokenVerifyResult } from './OAuthTypes.js';
import type { OAuthAccessTokenVerifier } from './OAuthTokenVerifier.js';

function splitScope(scope: string): string[] {
  return scope.split(/\s+/g).map((item) => item.trim()).filter(Boolean);
}

interface IdentityBindingLookup {
  getByCanonicalAccountId(canonicalAccountId: string): Promise<IdentityBinding | null>;
  getByDid?(did: string): Promise<IdentityBinding | null>;
}

interface BackendTokenIntrospectionResponse {
  active?: boolean;
  sub?: string;
  scope?: string;
  client_id?: string;
  canonical_account_id?: string;
  cnf?: { jkt?: string };
  exp?: number;
}

export interface BackendIntrospectionTokenVerifierDeps {
  introspectionUrl: string;
  introspectionBearerToken: string;
  dpopVerifier: DpopVerifier;
  nonceFactory: () => Promise<string>;
  identityBindings: IdentityBindingLookup;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class BackendIntrospectionTokenVerifier implements OAuthAccessTokenVerifier {
  private readonly timeoutMs: number;

  private readonly maxAttempts: number;

  constructor(private readonly deps: BackendIntrospectionTokenVerifierDeps) {
    this.timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(500, deps.timeoutMs) : 3000;
    this.maxAttempts = Number.isFinite(deps.maxAttempts) ? Math.max(1, Math.min(5, deps.maxAttempts)) : 3;
  }

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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid_dpop_proof';
      if (message === 'use_dpop_nonce') {
        return {
          session: null,
          errorCode: 'use_dpop_nonce',
          nonce: await this.deps.nonceFactory(),
        };
      }
      return { session: null, errorCode: 'invalid_dpop_proof' };
    }

    const introspection = await this.introspectAccessToken(bearer);
    if (!introspection?.active) {
      return { session: null, errorCode: 'invalid_token' };
    }

    if (!introspection.cnf?.jkt || introspection.cnf.jkt !== dpopJkt) {
      return { session: null, errorCode: 'invalid_dpop_proof' };
    }

    if (typeof introspection.sub !== 'string' || !introspection.sub.startsWith('did:')) {
      return { session: null, errorCode: 'invalid_token' };
    }

    if (typeof introspection.exp === 'number' && introspection.exp <= Math.floor(Date.now() / 1000)) {
      return { session: null, errorCode: 'invalid_token' };
    }

    const scope = typeof introspection.scope === 'string' ? introspection.scope : '';
    const scopeList = splitScope(scope);
    if (!scopeList.includes('atproto')) {
      return { session: null, errorCode: 'insufficient_scope' };
    }

    const binding = await this.resolveBinding(introspection);
    if (!binding?.canonicalAccountId || !binding.atprotoDid || !binding.atprotoHandle) {
      return { session: null, errorCode: 'invalid_token' };
    }

    const session: AtSessionContext = {
      canonicalAccountId: binding.canonicalAccountId,
      did: binding.atprotoDid,
      handle: binding.atprotoHandle,
      scope: scopeList.includes('transition:generic') ? 'app_password_restricted' : 'full',
    };

    return { session };
  }

  private async resolveBinding(
    introspection: BackendTokenIntrospectionResponse,
  ): Promise<IdentityBinding | null> {
    const canonicalAccountId =
      typeof introspection.canonical_account_id === 'string'
        ? introspection.canonical_account_id.trim()
        : '';
    if (canonicalAccountId) {
      return this.deps.identityBindings.getByCanonicalAccountId(canonicalAccountId);
    }
    if (typeof introspection.sub === 'string' && this.deps.identityBindings.getByDid) {
      return this.deps.identityBindings.getByDid(introspection.sub);
    }
    return null;
  }

  private async introspectAccessToken(
    accessToken: string,
  ): Promise<BackendTokenIntrospectionResponse | null> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await fetch(this.deps.introspectionUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.deps.introspectionBearerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: accessToken }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          if (attempt < this.maxAttempts) {
            await delay(this.backoffDelayMs(attempt));
            continue;
          }
          return null;
        }

        if (!response.ok) {
          return null;
        }

        return (await response.json()) as BackendTokenIntrospectionResponse;
      } catch {
        if (attempt >= this.maxAttempts) {
          return null;
        }
        await delay(this.backoffDelayMs(attempt));
      }
    }

    return null;
  }

  private backoffDelayMs(attempt: number): number {
    const baseDelay = Math.min(1000, 150 * (2 ** (attempt - 1)));
    return Math.floor(baseDelay / 2 + Math.random() * baseDelay);
  }
}