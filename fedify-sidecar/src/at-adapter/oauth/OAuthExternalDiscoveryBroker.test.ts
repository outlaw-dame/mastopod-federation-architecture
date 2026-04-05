import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthExternalDiscoveryBroker } from './OAuthExternalDiscoveryBroker.js';

describe('OAuthExternalDiscoveryBroker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves path-form did:web documents from /<path>/did.json', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'http://localhost:3000/user/alice/did.json') {
        return jsonResponse({
          id: 'did:web:localhost%3A3000:user:alice',
          alsoKnownAs: ['at://alice.localhost'],
          verificationMethod: [
            {
              id: 'did:web:localhost%3A3000:user:alice#atproto',
              type: 'Multikey',
              controller: 'did:web:localhost%3A3000:user:alice',
              publicKeyMultibase: 'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
            },
          ],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'http://localhost:3000',
            },
          ],
        });
      }
      if (url === 'http://localhost:3000/.well-known/oauth-protected-resource') {
        return jsonResponse({
          authorization_servers: ['http://localhost:3001'],
        });
      }
      if (url === 'http://localhost:3001/.well-known/oauth-authorization-server') {
        return jsonResponse({
          issuer: 'http://localhost:3001',
          authorization_endpoint: 'http://localhost:3001/authorize',
          token_endpoint: 'http://localhost:3001/token',
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const broker = new OAuthExternalDiscoveryBroker({
      allowLocalhostHttp: true,
      timeoutMs: 2_000,
      maxAttempts: 1,
    });

    const result = await broker.discover('did:web:localhost%3A3000:user:alice');

    expect(result.did).toBe('did:web:localhost%3A3000:user:alice');
    expect(result.pdsEndpoint).toBe('http://localhost:3000');
    expect(result.authorizationServer).toBe('http://localhost:3001');
  });
});

function jsonResponse(body: Record<string, unknown>): Response {
  const encoded = JSON.stringify(body);
  return new Response(encoded, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(encoded, 'utf8').toString(),
    },
  });
}
