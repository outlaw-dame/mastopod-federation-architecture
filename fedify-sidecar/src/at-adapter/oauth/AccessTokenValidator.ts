import type { OAuthTokenVerifyResult } from './OAuthTypes.js';
import type { OAuthAccessTokenVerifier } from './OAuthTokenVerifier.js';

export class AccessTokenValidator {
  constructor(private readonly verifier: OAuthAccessTokenVerifier) {}

  async validate(input: {
    authorizationHeader: string | undefined;
    dpopHeader: string | undefined;
    method: string;
    htu: string;
  }): Promise<OAuthTokenVerifyResult> {
    return this.verifier.verify(
      input.authorizationHeader,
      input.dpopHeader,
      input.method,
      input.htu,
    );
  }
}
