import type { OAuthClientMetadata } from './OAuthTypes.js';
import { OAuthError, ensureNonEmptyString } from './OAuthErrors.js';
import { assertSafeTarget, fetchJsonWithRetry } from './SafeHttpClient.js';

function isHttpsOrLocalhost(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export class OAuthClientMetadataFetcher {
  constructor(
    private readonly timeoutMs = 6_000,
    private readonly maxAttempts = 4,
    private readonly allowLocalhostHttp = true,
  ) {}

  async fetchAndValidate(clientId: string): Promise<OAuthClientMetadata> {
    const normalizedClientId = ensureNonEmptyString(clientId, 2048, 'client_id');
    const clientUrl = new URL(normalizedClientId);
    if (!isHttpsOrLocalhost(clientUrl)) {
      throw new OAuthError('invalid_request', 400, 'client_id must use HTTPS or localhost HTTP');
    }

    await assertSafeTarget(clientUrl, this.allowLocalhostHttp);

    const raw = await fetchJsonWithRetry(clientUrl, {
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });
    const redirectUris = asStringArray(raw['redirect_uris']);
    const grantTypes = asStringArray(raw['grant_types']);
    const responseTypes = asStringArray(raw['response_types']);

    const metadata: OAuthClientMetadata = {
      client_id: typeof raw['client_id'] === 'string' ? raw['client_id'].trim() : '',
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      scope: typeof raw['scope'] === 'string' ? raw['scope'] : undefined,
      token_endpoint_auth_method:
        raw['token_endpoint_auth_method'] === 'private_key_jwt'
          ? 'private_key_jwt'
          : 'none',
      dpop_bound_access_tokens: raw['dpop_bound_access_tokens'] === true,
      jwks_uri: typeof raw['jwks_uri'] === 'string' ? raw['jwks_uri'] : undefined,
    };

    if (metadata.client_id !== clientId) {
      throw new OAuthError('invalid_client', 400, 'client metadata client_id mismatch');
    }
    if (!metadata.redirect_uris.length) {
      throw new OAuthError('invalid_client', 400, 'client metadata missing redirect_uris');
    }
    if (!metadata.grant_types.includes('authorization_code')) {
      throw new OAuthError('invalid_client', 400, 'client metadata must include authorization_code grant');
    }
    if (!metadata.response_types.includes('code')) {
      throw new OAuthError('invalid_client', 400, 'client metadata must include code response type');
    }
    if (metadata.dpop_bound_access_tokens !== true) {
      throw new OAuthError('invalid_client', 400, 'client metadata must enable dpop_bound_access_tokens');
    }

    return metadata;
  }
}
