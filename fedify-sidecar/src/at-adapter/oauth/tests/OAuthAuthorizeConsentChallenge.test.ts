import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerOAuthRouteHandlers } from '../OAuthRouteHandlers.js';
import type {
  OAuthAuthorizationContext,
  OAuthAuthorizeInput,
  OAuthParInput,
  OAuthAuthorizationServer,
  OAuthTokenExchangeInput,
  OAuthTokenPair,
} from '../OAuthTypes.js';
import type { AtSessionContext, AtSessionCreateResult, AtSessionService } from '../../auth/AtSessionTypes.js';

class InMemoryConsentChallengeStore {
  private readonly store = new Map<string, {
    challengeId: string;
    requestUri: string;
    fingerprint: string;
    createdAtEpochSec: number;
    expiresAtEpochSec: number;
  }>();

  async mint(requestUri: string, fingerprint: string, ttlSec: number) {
    const challengeId = `challenge-${Math.random().toString(36).slice(2)}`;
    const now = Math.floor(Date.now() / 1000);
    const record = {
      challengeId,
      requestUri,
      fingerprint,
      createdAtEpochSec: now,
      expiresAtEpochSec: now + ttlSec,
    };
    this.store.set(challengeId, record);
    return record;
  }

  async consume(challengeId: string) {
    const record = this.store.get(challengeId) ?? null;
    if (record) {
      this.store.delete(challengeId);
    }
    return record;
  }
}

class StubAuthorizationServer implements OAuthAuthorizationServer {
  private readonly contexts = new Map<string, OAuthAuthorizationContext>();

  constructor() {
    this.contexts.set('urn:ietf:params:oauth:request_uri:req-1', {
      requestUri: 'urn:ietf:params:oauth:request_uri:req-1',
      clientId: 'https://client.example',
      redirectUri: 'https://client.example/callback',
      scope: 'atproto transition:generic',
      state: 'state-1',
      expiresAtEpochSec: Math.floor(Date.now() / 1000) + 180,
    });
  }

  async initialize(): Promise<void> {}

  getAuthorizationServerMetadata() {
    return {
      issuer: 'https://as.example',
      authorization_endpoint: 'https://as.example/oauth/authorize',
      token_endpoint: 'https://as.example/oauth/token',
      pushed_authorization_request_endpoint: 'https://as.example/oauth/par',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      dpop_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['atproto'],
      client_id_metadata_document_supported: true,
    };
  }

  getProtectedResourceMetadata() {
    return {
      resource: 'https://rs.example',
      authorization_servers: ['https://as.example'],
      bearer_methods_supported: ['DPoP'],
    };
  }

  async getAuthorizationContext(requestUri: string): Promise<OAuthAuthorizationContext | null> {
    return this.contexts.get(requestUri) ?? null;
  }

  async createPushedAuthorizationRequest(_payload: OAuthParInput, _dpopJkt: string) {
    return { request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 180 };
  }

  async authorize(input: OAuthAuthorizeInput) {
    const context = this.contexts.get(input.requestUri);
    if (!context) {
      throw new Error('missing context');
    }
    return {
      code: 'auth-code-1',
      state: context.state,
      redirectUri: context.redirectUri,
    };
  }

  async reject(requestUri: string) {
    const context = this.contexts.get(requestUri);
    if (!context) {
      throw new Error('missing context');
    }
    return {
      state: context.state,
      redirectUri: context.redirectUri,
    };
  }

  async exchangeToken(_input: OAuthTokenExchangeInput, _dpopJkt: string): Promise<OAuthTokenPair> {
    throw new Error('not implemented');
  }

  async mintDpopNonce(): Promise<string> {
    return 'nonce-1';
  }
}

class StubSessionService implements AtSessionService {
  async createSession(_identifier: string, _password: string): Promise<AtSessionCreateResult> {
    throw new Error('not implemented');
  }

  async refreshSession(_refreshJwt: string): Promise<AtSessionCreateResult> {
    throw new Error('not implemented');
  }

  async verifyAccessToken(jwt: string): Promise<AtSessionContext | null> {
    if (jwt === 'good-token') {
      return {
        canonicalAccountId: 'https://pods.test/users/alice',
        did: 'did:plc:testalice',
        handle: 'alice.test',
        scope: 'full',
      };
    }
    return null;
  }

  async mintAccessToken(_ctx: AtSessionContext): Promise<string> {
    throw new Error('not implemented');
  }

  async mintRefreshToken(_ctx: AtSessionContext): Promise<string> {
    throw new Error('not implemented');
  }
}

const dpopVerifierStub = {
  verify: async () => ({
    jkt: 'jkt-1',
    jti: 'jti-1',
    iat: Math.floor(Date.now() / 1000),
  }),
};

describe('OAuth authorize consent challenge flow', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
  });

  async function buildApp() {
    const app = Fastify({ trustProxy: true });
    apps.push(app);

    registerOAuthRouteHandlers(app, {
      authorizationServer: new StubAuthorizationServer(),
      dpopVerifier: dpopVerifierStub as any,
      sessionService: new StubSessionService(),
      consentChallengeStore: new InMemoryConsentChallengeStore() as any,
    });

    await app.ready();
    return app;
  }

  it('consumes consent challenge only once', async () => {
    const app = await buildApp();

    const getResponse = await app.inject({
      method: 'GET',
      url: '/oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:req-1',
      headers: { 'user-agent': 'consent-test-agent/1.0' },
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json() as { consent_challenge: string };

    const firstPost = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'user-agent': 'consent-test-agent/1.0' },
      payload: {
        request_uri: 'urn:ietf:params:oauth:request_uri:req-1',
        consent_challenge: getBody.consent_challenge,
        decision: 'deny',
      },
    });

    expect(firstPost.statusCode).toBe(302);
    expect(firstPost.headers.location).toContain('error=access_denied');

    const secondPost = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'user-agent': 'consent-test-agent/1.0' },
      payload: {
        request_uri: 'urn:ietf:params:oauth:request_uri:req-1',
        consent_challenge: getBody.consent_challenge,
        decision: 'deny',
      },
    });

    expect(secondPost.statusCode).toBe(400);
    expect(secondPost.json()).toMatchObject({ error: 'access_denied' });
  });

  it('rejects fingerprint mismatch between GET and POST', async () => {
    const app = await buildApp();

    const getResponse = await app.inject({
      method: 'GET',
      url: '/oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:req-1',
      headers: { 'user-agent': 'agent-a/1.0' },
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json() as { consent_challenge: string };

    const postResponse = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'user-agent': 'agent-b/1.0' },
      payload: {
        request_uri: 'urn:ietf:params:oauth:request_uri:req-1',
        consent_challenge: getBody.consent_challenge,
        decision: 'deny',
      },
    });

    expect(postResponse.statusCode).toBe(400);
    expect(postResponse.json()).toMatchObject({
      error: 'access_denied',
      error_description: 'consent challenge fingerprint mismatch',
    });
  });

  it('allows approve decision with valid local session token', async () => {
    const app = await buildApp();

    const getResponse = await app.inject({
      method: 'GET',
      url: '/oauth/authorize?request_uri=urn:ietf:params:oauth:request_uri:req-1',
      headers: { 'user-agent': 'approve-agent/1.0' },
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json() as { consent_challenge: string };

    const postResponse = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: {
        'user-agent': 'approve-agent/1.0',
        authorization: 'Bearer good-token',
      },
      payload: {
        request_uri: 'urn:ietf:params:oauth:request_uri:req-1',
        consent_challenge: getBody.consent_challenge,
        decision: 'approve',
      },
    });

    expect(postResponse.statusCode).toBe(302);
    expect(postResponse.headers.location).toContain('code=auth-code-1');
    expect(postResponse.headers.location).toContain('state=state-1');
  });
});
