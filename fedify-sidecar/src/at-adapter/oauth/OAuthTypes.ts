import type { AtSessionContext } from '../auth/AtSessionTypes.js';

export interface OAuthClientMetadata {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope?: string;
  token_endpoint_auth_method?: 'none' | 'private_key_jwt';
  dpop_bound_access_tokens?: boolean;
  jwks_uri?: string;
}

export interface OAuthParInput {
  client_id: string;
  redirect_uri: string;
  response_type: 'code';
  scope: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: 'S256';
}

export interface OAuthParStoredRequest extends OAuthParInput {
  requestUri: string;
  expiresAtEpochSec: number;
  createdAtEpochSec: number;
  dpopJkt?: string;
}

export interface OAuthAuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  subjectDid: string;
  canonicalAccountId: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  grantId: string;
  createdAtEpochSec: number;
  expiresAtEpochSec: number;
  dpopJkt?: string;
}

export interface OAuthGrantRecord {
  grantId: string;
  subjectDid: string;
  canonicalAccountId: string;
  clientId: string;
  scope: string;
  createdAtEpochSec: number;
  updatedAtEpochSec: number;
}

export interface OAuthRefreshTokenRecord {
  refreshTokenId: string;
  familyId: string;
  grantId: string;
  subjectDid: string;
  canonicalAccountId: string;
  clientId: string;
  scope: string;
  issuedAtEpochSec: number;
  expiresAtEpochSec: number;
  revokedAtEpochSec?: number;
  replacedByTokenId?: string;
  dpopJkt?: string;
}

export interface OAuthDpopNonceRecord {
  nonce: string;
  expiresAtEpochSec: number;
}

export interface OAuthTokenPair {
  access_token: string;
  token_type: 'DPoP';
  expires_in: number;
  scope: string;
  refresh_token: string;
}

export interface OAuthTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  scope: string;
  act: string;
  token_use: 'access' | 'refresh';
  grant_id: string;
  client_id: string;
  cnf?: { jkt: string };
  jti: string;
}

export interface OAuthAuthorizeInput {
  requestUri: string;
  subjectDid: string;
  canonicalAccountId: string;
}

export interface OAuthAuthorizationContext {
  requestUri: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  expiresAtEpochSec: number;
}

export interface OAuthTokenExchangeInput {
  grant_type: 'authorization_code' | 'refresh_token';
  client_id: string;
  redirect_uri?: string;
  code?: string;
  code_verifier?: string;
  refresh_token?: string;
}

export interface OAuthDpopVerifyInput {
  proofJwt: string;
  htm: string;
  htu: string;
  nonce?: string;
  accessToken?: string;
}

export interface OAuthDpopVerifyResult {
  jkt: string;
  jti: string;
  iat: number;
}

export interface OAuthTokenVerifyResult {
  session: AtSessionContext | null;
  errorCode?: 'invalid_token' | 'use_dpop_nonce' | 'invalid_dpop_proof' | 'insufficient_scope';
  nonce?: string;
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  dpop_signing_alg_values_supported: string[];
  scopes_supported: string[];
  client_id_metadata_document_supported: boolean;
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

export interface OAuthAuthorizationServer {
  initialize(): Promise<void>;
  getAuthorizationServerMetadata(): OAuthAuthorizationServerMetadata;
  getProtectedResourceMetadata(): OAuthProtectedResourceMetadata;
  getAuthorizationContext(requestUri: string): Promise<OAuthAuthorizationContext | null>;
  createPushedAuthorizationRequest(
    payload: OAuthParInput,
    dpopJkt: string
  ): Promise<{ request_uri: string; expires_in: number }>;
  authorize(input: OAuthAuthorizeInput): Promise<{ code: string; state?: string; redirectUri: string }>;
  reject(requestUri: string): Promise<{ state?: string; redirectUri: string }>;
  exchangeToken(
    input: OAuthTokenExchangeInput,
    dpopJkt: string
  ): Promise<OAuthTokenPair>;
  mintDpopNonce(): Promise<string>;
}
