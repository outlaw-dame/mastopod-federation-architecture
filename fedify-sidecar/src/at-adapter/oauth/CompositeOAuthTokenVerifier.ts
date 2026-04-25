import type { OAuthTokenVerifyResult } from './OAuthTypes.js';
import type { OAuthAccessTokenVerifier } from './OAuthTokenVerifier.js';

export class CompositeOAuthTokenVerifier implements OAuthAccessTokenVerifier {
  constructor(private readonly verifiers: readonly OAuthAccessTokenVerifier[]) {}

  async verify(
    authHeader: string | undefined,
    dpopHeader: string | undefined,
    method: string,
    htu: string,
  ): Promise<OAuthTokenVerifyResult> {
    let lastInvalidToken: OAuthTokenVerifyResult = {
      session: null,
      errorCode: 'invalid_token',
    };

    for (const verifier of this.verifiers) {
      const result = await verifier.verify(authHeader, dpopHeader, method, htu);
      if (result.session) {
        return result;
      }
      if (result.errorCode && result.errorCode !== 'invalid_token') {
        return result;
      }
      lastInvalidToken = result;
    }

    return lastInvalidToken;
  }
}