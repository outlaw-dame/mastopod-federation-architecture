import { createHash, randomUUID } from 'node:crypto';
import { importJWK, jwtVerify } from 'jose';
import type {
  OAuthAuthorizationCodeRecord,
  OAuthAuthorizationContext,
  OAuthAuthorizeInput,
  OAuthAuthorizationServer as OAuthAuthorizationServerContract,
  OAuthAuthorizationServerMetadata,
  OAuthParInput,
  OAuthProtectedResourceMetadata,
  OAuthTokenExchangeInput,
  OAuthTokenPair,
  OAuthTokenPayload,
} from './OAuthTypes.js';
import {
  OAuthAuthorizationCodeStore,
  OAuthDpopNonceStore,
  OAuthGrantStore,
  OAuthParStore,
  OAuthRefreshTokenStore,
} from './OAuthRedisStores.js';
import { OAuthAsKeyManager } from './OAuthAsKeyManager.js';
import { OAuthClientMetadataFetcher } from './OAuthClientMetadataFetcher.js';
import { OAuthError, ensureNonEmptyString } from './OAuthErrors.js';

export interface OAuthAuthorizationServerDeps {
  issuer: string;
  authorizationServerOrigin: string;
  resourceServerOrigin: string;
  keyManager: OAuthAsKeyManager;
  clientMetadataFetcher: OAuthClientMetadataFetcher;
  parStore: OAuthParStore;
  codeStore: OAuthAuthorizationCodeStore;
  refreshStore: OAuthRefreshTokenStore;
  grantStore: OAuthGrantStore;
  nonceStore: OAuthDpopNonceStore;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  parTtlSec?: number;
  authCodeTtlSec?: number;
}

export class OAuthAuthorizationServer implements OAuthAuthorizationServerContract {
  private readonly accessTokenTtlSec: number;
  private readonly refreshTokenTtlSec: number;
  private readonly parTtlSec: number;
  private readonly authCodeTtlSec: number;

  constructor(private readonly deps: OAuthAuthorizationServerDeps) {
    this.accessTokenTtlSec = deps.accessTokenTtlSec ?? 600;
    this.refreshTokenTtlSec = deps.refreshTokenTtlSec ?? 60 * 60 * 24 * 30;
    this.parTtlSec = deps.parTtlSec ?? 300;
    this.authCodeTtlSec = deps.authCodeTtlSec ?? 300;
  }

  async initialize(): Promise<void> {
    await this.deps.keyManager.initialize();
  }

  getAuthorizationServerMetadata(): OAuthAuthorizationServerMetadata {
    return {
      issuer: this.deps.issuer,
      authorization_endpoint: `${this.deps.authorizationServerOrigin}/oauth/authorize`,
      token_endpoint: `${this.deps.authorizationServerOrigin}/oauth/token`,
      pushed_authorization_request_endpoint: `${this.deps.authorizationServerOrigin}/oauth/par`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      dpop_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['atproto', 'blob:*/*', 'transition:generic'],
      client_id_metadata_document_supported: true,
    };
  }

  getProtectedResourceMetadata(): OAuthProtectedResourceMetadata {
    return {
      resource: this.deps.resourceServerOrigin,
      authorization_servers: [this.deps.authorizationServerOrigin],
      bearer_methods_supported: ['header'],
      resource_documentation: `${this.deps.resourceServerOrigin}/docs/atproto-oauth`,
    };
  }

  async createPushedAuthorizationRequest(
    payload: OAuthParInput,
    dpopJkt: string,
  ): Promise<{ request_uri: string; expires_in: number }> {
    const clientId = ensureNonEmptyString(payload.client_id, 2048, 'client_id');
    const redirectUri = ensureNonEmptyString(payload.redirect_uri, 2048, 'redirect_uri');
    const scope = ensureNonEmptyString(payload.scope, 1024, 'scope');
    const codeChallenge = ensureNonEmptyString(payload.code_challenge, 256, 'code_challenge');
    if (!scope.split(/\s+/g).includes('atproto')) {
      throw new OAuthError('invalid_scope', 400, 'scope must include atproto');
    }

    const metadata = await this.deps.clientMetadataFetcher.fetchAndValidate(payload.client_id);
    if (!metadata.redirect_uris.includes(redirectUri)) {
      throw new OAuthError('invalid_request', 400, 'redirect_uri is not registered');
    }

    const requestUri = `urn:ietf:params:oauth:request_uri:${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);

    await this.deps.parStore.put({
      ...payload,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      code_challenge: codeChallenge,
      requestUri,
      createdAtEpochSec: now,
      expiresAtEpochSec: now + this.parTtlSec,
      dpopJkt,
    });

    return {
      request_uri: requestUri,
      expires_in: this.parTtlSec,
    };
  }

  async getAuthorizationContext(requestUri: string): Promise<OAuthAuthorizationContext | null> {
    const normalizedRequestUri = ensureNonEmptyString(requestUri, 4096, 'request_uri');
    const par = await this.deps.parStore.get(normalizedRequestUri);
    if (!par) {
      return null;
    }

    return {
      requestUri: normalizedRequestUri,
      clientId: par.client_id,
      redirectUri: par.redirect_uri,
      scope: par.scope,
      state: par.state,
      expiresAtEpochSec: par.expiresAtEpochSec,
    };
  }

  async authorize(input: OAuthAuthorizeInput): Promise<{ code: string; state?: string; redirectUri: string }> {
    const requestUri = ensureNonEmptyString(input.requestUri, 4096, 'request_uri');
    const subjectDid = ensureNonEmptyString(input.subjectDid, 320, 'subject_did');
    const canonicalAccountId = ensureNonEmptyString(input.canonicalAccountId, 1024, 'canonical_account_id');

    const par = await this.deps.parStore.consume(requestUri);
    if (!par) {
      throw new OAuthError('invalid_request', 400, 'request_uri is invalid or expired');
    }

    const now = Math.floor(Date.now() / 1000);
    const grant = await this.deps.grantStore.createOrUpdate({
      subjectDid,
      canonicalAccountId,
      clientId: par.client_id,
      scope: par.scope,
    });

    const code = randomUUID();
    const codeRecord: OAuthAuthorizationCodeRecord = {
      code,
      clientId: par.client_id,
      redirectUri: par.redirect_uri,
      subjectDid,
      canonicalAccountId,
      scope: par.scope,
      codeChallenge: par.code_challenge,
      codeChallengeMethod: par.code_challenge_method,
      grantId: grant.grantId,
      createdAtEpochSec: now,
      expiresAtEpochSec: now + this.authCodeTtlSec,
      dpopJkt: par.dpopJkt,
    };
    await this.deps.codeStore.put(codeRecord);

    return {
      code,
      state: par.state,
      redirectUri: par.redirect_uri,
    };
  }

  async reject(requestUri: string): Promise<{ state?: string; redirectUri: string }> {
    const normalizedRequestUri = ensureNonEmptyString(requestUri, 4096, 'request_uri');
    const par = await this.deps.parStore.consume(normalizedRequestUri);
    if (!par) {
      throw new OAuthError('invalid_request', 400, 'request_uri is invalid or expired');
    }

    return {
      state: par.state,
      redirectUri: par.redirect_uri,
    };
  }

  async exchangeToken(input: OAuthTokenExchangeInput, dpopJkt: string): Promise<OAuthTokenPair> {
    if (input.grant_type === 'authorization_code') {
      return this.exchangeAuthorizationCode(input, dpopJkt);
    }
    return this.exchangeRefreshToken(input, dpopJkt);
  }

  private async exchangeAuthorizationCode(input: OAuthTokenExchangeInput, dpopJkt: string): Promise<OAuthTokenPair> {
    if (!input.code || !input.redirect_uri || !input.code_verifier) {
      throw new OAuthError('invalid_request', 400, 'authorization_code exchange is missing required fields');
    }

    const codeRecord = await this.deps.codeStore.consume(input.code);
    if (!codeRecord) {
      throw new OAuthError('invalid_grant', 400, 'authorization code is invalid or expired');
    }

    if (codeRecord.clientId !== input.client_id) {
      throw new OAuthError('invalid_client', 401, 'client_id does not match code');
    }
    if (codeRecord.redirectUri !== input.redirect_uri) {
      throw new OAuthError('invalid_grant', 400, 'redirect_uri mismatch');
    }

    const computedChallenge = createHash('sha256')
      .update(input.code_verifier)
      .digest('base64url');
    if (computedChallenge !== codeRecord.codeChallenge) {
      throw new OAuthError('invalid_grant', 400, 'code_verifier is invalid');
    }

    if (codeRecord.dpopJkt && codeRecord.dpopJkt !== dpopJkt) {
      throw new OAuthError('invalid_dpop_proof', 401, 'DPoP key binding mismatch');
    }

    return this.issueTokenPair({
      subjectDid: codeRecord.subjectDid,
      canonicalAccountId: codeRecord.canonicalAccountId,
      clientId: codeRecord.clientId,
      scope: codeRecord.scope,
      grantId: codeRecord.grantId,
      dpopJkt,
      familyId: randomUUID(),
    });
  }

  private async exchangeRefreshToken(input: OAuthTokenExchangeInput, dpopJkt: string): Promise<OAuthTokenPair> {
    if (!input.refresh_token) {
      throw new OAuthError('invalid_request', 400, 'refresh_token is required');
    }

    const publicJwk = await this.deps.keyManager.getPublicJwk();
    const { payload } = await jwtVerify(
      input.refresh_token,
      await importJWK(publicJwk, 'ES256'),
      {
        issuer: this.deps.issuer,
        audience: this.deps.authorizationServerOrigin,
        algorithms: ['ES256'],
      }
    ).catch(() => {
      throw new OAuthError('invalid_grant', 400, 'refresh_token is invalid');
    });

    const refreshPayload = payload as unknown as Partial<OAuthTokenPayload>;
    if (refreshPayload.token_use !== 'refresh') {
      throw new OAuthError('invalid_grant', 400, 'token_use is invalid for refresh exchange');
    }

    const refreshTokenId = typeof refreshPayload.jti === 'string' ? refreshPayload.jti : '';
    if (!refreshTokenId) {
      throw new OAuthError('invalid_grant', 400, 'refresh_token jti is missing');
    }

    const current = await this.deps.refreshStore.get(refreshTokenId);
    if (!current || current.revokedAtEpochSec) {
      throw new OAuthError('invalid_grant', 400, 'refresh_token is revoked or unknown');
    }
    if (current.clientId !== input.client_id) {
      throw new OAuthError('invalid_client', 401, 'client_id does not match refresh token');
    }
    if (current.dpopJkt && current.dpopJkt !== dpopJkt) {
      throw new OAuthError('invalid_dpop_proof', 401, 'DPoP key binding mismatch');
    }

    const now = Math.floor(Date.now() / 1000);
    await this.deps.refreshStore.revoke(current.refreshTokenId, now);

    return this.issueTokenPair({
      subjectDid: current.subjectDid,
      canonicalAccountId: current.canonicalAccountId,
      clientId: current.clientId,
      scope: current.scope,
      grantId: current.grantId,
      dpopJkt,
      familyId: current.familyId,
      replacedTokenId: current.refreshTokenId,
    });
  }

  private async issueTokenPair(input: {
    subjectDid: string;
    canonicalAccountId: string;
    clientId: string;
    scope: string;
    grantId: string;
    dpopJkt: string;
    familyId: string;
    replacedTokenId?: string;
  }): Promise<OAuthTokenPair> {
    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessPayload: Omit<OAuthTokenPayload, 'iss' | 'sub' | 'aud' | 'jti'> = {
      scope: input.scope,
      act: input.canonicalAccountId,
      token_use: 'access',
      grant_id: input.grantId,
      client_id: input.clientId,
      cnf: { jkt: input.dpopJkt },
    };

    const refreshPayload: Omit<OAuthTokenPayload, 'iss' | 'sub' | 'aud' | 'jti'> = {
      scope: input.scope,
      act: input.canonicalAccountId,
      token_use: 'refresh',
      grant_id: input.grantId,
      client_id: input.clientId,
      cnf: { jkt: input.dpopJkt },
    };

    const access_token = await this.deps.keyManager.signJwt(
      accessPayload,
      this.deps.issuer,
      this.deps.resourceServerOrigin,
      input.subjectDid,
      accessJti,
      this.accessTokenTtlSec,
    );

    const refresh_token = await this.deps.keyManager.signJwt(
      refreshPayload,
      this.deps.issuer,
      this.deps.authorizationServerOrigin,
      input.subjectDid,
      refreshJti,
      this.refreshTokenTtlSec,
    );

    const now = Math.floor(Date.now() / 1000);
    await this.deps.refreshStore.put({
      refreshTokenId: refreshJti,
      familyId: input.familyId,
      grantId: input.grantId,
      subjectDid: input.subjectDid,
      canonicalAccountId: input.canonicalAccountId,
      clientId: input.clientId,
      scope: input.scope,
      issuedAtEpochSec: now,
      expiresAtEpochSec: now + this.refreshTokenTtlSec,
      dpopJkt: input.dpopJkt,
      replacedByTokenId: input.replacedTokenId,
    });

    return {
      access_token,
      token_type: 'DPoP',
      expires_in: this.accessTokenTtlSec,
      scope: input.scope,
      refresh_token,
    };
  }

  async mintDpopNonce(): Promise<string> {
    const rec = await this.deps.nonceStore.mintNonce(300);
    return rec.nonce;
  }
}
