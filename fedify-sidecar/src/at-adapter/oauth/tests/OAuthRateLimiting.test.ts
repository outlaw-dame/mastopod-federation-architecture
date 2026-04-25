import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerOAuthRouteHandlers, type OAuthRouteRateLimits } from '../OAuthRouteHandlers.js';
import type {
  OAuthAuthorizationContext,
  OAuthAuthorizeInput,
  OAuthAuthorizationServer,
  OAuthParInput,
  OAuthTokenExchangeInput,
  OAuthTokenPair,
} from '../OAuthTypes.js';

class StubAuthorizationServer implements OAuthAuthorizationServer {
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

  async getAuthorizationContext(_requestUri: string): Promise<OAuthAuthorizationContext | null> {
    return null;
  }

  async createPushedAuthorizationRequest(_payload: OAuthParInput, _dpopJkt: string) {
    return { request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 180 };
  }

  async authorize(_input: OAuthAuthorizeInput) {
    return {
      code: 'auth-code-1',
      state: 'state-1',
      redirectUri: 'https://client.example/callback',
    };
  }

  async reject(_requestUri: string) {
    return {
      state: 'state-1',
      redirectUri: 'https://client.example/callback',
    };
  }

  async exchangeToken(_input: OAuthTokenExchangeInput, _dpopJkt: string): Promise<OAuthTokenPair> {
    return {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'DPoP',
      scope: 'atproto',
      expires_in: 3600,
    };
  }

  async mintDpopNonce(): Promise<string> {
    return 'nonce-1';
  }
}

class InMemoryRateLimitStore {
  private readonly counters = new Map<string, number>();

  async consume(key: string, limit: number, _windowSec: number) {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const allowed = next <= limit;
    return {
      allowed,
      count: next,
      limit,
      remaining: Math.max(0, limit - next),
      retryAfterSec: allowed ? 1 : 60,
      resetAtEpochSec: Math.floor(Date.now() / 1000) + (allowed ? 1 : 60),
    };
  }
}

class ThrowingRateLimitStore {
  async consume(): Promise<never> {
    throw new Error('redis temporarily unavailable');
  }
}

const dpopVerifierStub = {
  verify: async () => ({
    jkt: 'jkt-1',
    jti: 'jti-1',
    iat: Math.floor(Date.now() / 1000),
  }),
};

const externalDiscoveryBrokerStub = {
  discover: async (identifier: string) => ({
    identifier,
    did: 'did:plc:alice',
    pdsUrl: 'https://pds.example',
    authorizationServerIssuer: 'https://as.example',
  }),
};

const tightExternalRateLimits: Partial<OAuthRouteRateLimits> = {
  externalDiscover: {
    windowSec: 60,
    perIpLimit: 100,
    perDimensionLimit: 1,
    perIpDimensionLimit: 1,
  },
};

describe('OAuth route rate limiting', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
  });

  async function buildApp(rateLimitStore: unknown) {
    const app = Fastify({ trustProxy: true });
    apps.push(app);

    registerOAuthRouteHandlers(app, {
      authorizationServer: new StubAuthorizationServer(),
      dpopVerifier: dpopVerifierStub as any,
      externalDiscoveryBroker: externalDiscoveryBrokerStub as any,
      rateLimitStore: rateLimitStore as any,
      rateLimits: tightExternalRateLimits,
    });

    await app.ready();
    return app;
  }

  it('returns 429 with Retry-After for repeated identifier requests', async () => {
    const app = await buildApp(new InMemoryRateLimitStore());

    const first = await app.inject({
      method: 'POST',
      url: '/oauth/external/discover',
      payload: { identifier: 'alice.example' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/oauth/external/discover',
      payload: { identifier: 'alice.example' },
    });

    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
    expect(second.json()).toMatchObject({
      error: 'temporarily_unavailable',
      error_description: 'Too many requests',
    });
  });

  it('keeps different identifiers isolated under adaptive dimension limits', async () => {
    const app = await buildApp(new InMemoryRateLimitStore());

    const first = await app.inject({
      method: 'POST',
      url: '/oauth/external/discover',
      payload: { identifier: 'alice.example' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/oauth/external/discover',
      payload: { identifier: 'bob.example' },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ identifier: 'bob.example' });
  });

  it('fails closed with 503 when limiter backend is unavailable', async () => {
    const app = await buildApp(new ThrowingRateLimitStore());

    const response = await app.inject({
      method: 'POST',
      url: '/oauth/external/discover',
      payload: { identifier: 'alice.example' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: 'temporarily_unavailable',
      error_description: 'Rate limiter unavailable',
    });
  });
});
