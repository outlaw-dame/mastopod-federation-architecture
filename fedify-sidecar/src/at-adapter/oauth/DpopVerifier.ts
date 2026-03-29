import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { OAuthDpopVerifyInput, OAuthDpopVerifyResult } from './OAuthTypes.js';
import { OAuthDpopNonceStore } from './OAuthRedisStores.js';

export class DpopVerifier {
  constructor(
    private readonly nonceStore: OAuthDpopNonceStore,
    private readonly maxSkewSec = 300,
  ) {}

  async verify(input: OAuthDpopVerifyInput): Promise<OAuthDpopVerifyResult> {
    const header = decodeProtectedHeader(input.proofJwt);
    if (header.typ !== 'dpop+jwt') {
      throw new Error('invalid_dpop_typ');
    }
    if (header.alg !== 'ES256') {
      throw new Error('invalid_dpop_alg');
    }
    if (!header.jwk || typeof header.jwk !== 'object') {
      throw new Error('missing_dpop_jwk');
    }

    const keyLike = await importJWK(header.jwk, 'ES256');
    const { payload } = await jwtVerify(input.proofJwt, keyLike, {
      algorithms: ['ES256'],
    });

    const htm = typeof payload['htm'] === 'string' ? payload['htm'] : '';
    const htu = typeof payload['htu'] === 'string' ? payload['htu'] : '';
    const jti = typeof payload.jti === 'string' ? payload.jti : '';
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    const nonce = typeof payload['nonce'] === 'string' ? payload['nonce'] : undefined;

    if (!htm || !htu || !jti || !iat) {
      throw new Error('invalid_dpop_payload');
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - iat) > this.maxSkewSec) {
      throw new Error('dpop_iat_out_of_range');
    }

    if (htm.toUpperCase() !== input.htm.toUpperCase()) {
      throw new Error('dpop_htm_mismatch');
    }

    if (htu !== input.htu) {
      throw new Error('dpop_htu_mismatch');
    }

    if (input.nonce) {
      if (nonce !== input.nonce) {
        throw new Error('use_dpop_nonce');
      }
      const isValidNonce = await this.nonceStore.verifyNonce(input.nonce);
      if (!isValidNonce) {
        throw new Error('use_dpop_nonce');
      }
    }

    const jkt = await calculateJwkThumbprint(header.jwk, 'sha256');

    const replayAccepted = await this.nonceStore.rememberProofJti(jkt, jti, this.maxSkewSec);
    if (!replayAccepted) {
      throw new Error('dpop_replay_detected');
    }

    if (input.accessToken) {
      const tokenHash = createHash('sha256').update(input.accessToken).digest('base64url');
      const ath = typeof payload['ath'] === 'string' ? payload['ath'] : '';
      if (!ath || ath !== tokenHash) {
        throw new Error('invalid_dpop_ath');
      }
    }

    return { jkt, jti, iat };
  }
}
