/**
 * OAuthDpopKeyManager
 *
 * Utilities for generating ES256 DPoP key pairs and building per-request
 * DPoP proof JWTs as required by RFC 9449 and the ATProto OAuth profile.
 *
 * These keys are used when the sidecar acts as an OAuth CLIENT connecting to
 * external PDSes on behalf of linked accounts. Each linked account session
 * carries its own DPoP private key (stored encrypted in ExternalAtSessionStore)
 * so that access tokens are bound to that specific key material.
 *
 * Usage pattern:
 *   const keypair = await generateDpopKeypair();
 *   // store keypair.privateKeyJwk alongside the session
 *   const proof = await buildDpopProof({ privateKeyJwk, htu, htm, accessToken });
 *   // add proof as the `DPoP` request header; use `DPoP ${accessToken}`
 *   // as the Authorization header (NOT Bearer)
 */

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose';
import { randomBytes, createHash } from 'node:crypto';

/**
 * An ES256 DPoP key pair. The private key JWK is serialized as a JSON string
 * so it can be stored directly in Redis (via ExternalAtSessionStore encryption)
 * without an extra serialization layer.
 */
export interface DpopKeypair {
  /** JSON-serialized ES256 private JWK (includes the `d` parameter). */
  privateKeyJwk: string;
  /** ES256 public JWK (no `d`). Suitable for inclusion in DPoP proof headers. */
  publicKeyJwk: JWK;
  /**
   * SHA-256 thumbprint of the public key (base64url).
   * Use this as the `dpop_jkt` value when requesting authorization — the
   * returned access token will be bound to this thumbprint.
   */
  thumbprint: string;
}

/**
 * Generate a fresh ES256 DPoP key pair.
 * Call this once when initiating an OAuth linking flow and store the private
 * key alongside the resulting access/refresh tokens.
 */
export async function generateDpopKeypair(): Promise<DpopKeypair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });

  const privateJwk = await exportJWK(privateKey);
  const publicJwk  = await exportJWK(publicKey);

  const thumbprint = await calculateJwkThumbprint(publicJwk as Parameters<typeof calculateJwkThumbprint>[0]);

  // Embed kid = thumbprint so the JWK is self-identifying
  privateJwk.kid = thumbprint;
  publicJwk.kid  = thumbprint;

  return {
    privateKeyJwk: JSON.stringify(privateJwk),
    publicKeyJwk: publicJwk,
    thumbprint,
  };
}

export interface BuildDpopProofOptions {
  /** JSON-serialized private JWK (as returned by generateDpopKeypair). */
  privateKeyJwk: string;
  /**
   * Full URL of the target endpoint, WITHOUT query parameters.
   * RFC 9449 §4.1 requires this to match exactly (case-sensitive scheme+host+path).
   */
  htu: string;
  /** HTTP method in uppercase (e.g. 'POST', 'GET'). */
  htm: string;
  /**
   * The access token being used in the request. When provided the DPoP proof
   * will include an `ath` claim bound to the token (RFC 9449 §4.2), which is
   * required for resource-server access (as opposed to token-endpoint requests).
   */
  accessToken?: string;
  /**
   * When the resource/auth server has issued a `DPoP-Nonce` response header,
   * replay that value here. Some servers require the `nonce` claim.
   */
  nonce?: string;
}

interface DpopProofPayload extends JWTPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  ath?: string;
  nonce?: string;
}

/**
 * Build a signed DPoP proof JWT for a single request.
 * Returns the compact JWT string to be sent as the `DPoP` HTTP header.
 */
export async function buildDpopProof(opts: BuildDpopProofOptions): Promise<string> {
  const privateJwk = JSON.parse(opts.privateKeyJwk) as JWK;
  const privateKey = await importJWK(privateJwk, 'ES256');

  // Strip private key material for the header jwk (MUST be public key only)
  const { d: _d, ...publicJwk } = privateJwk;

  const payload: DpopProofPayload = {
    jti: randomBytes(16).toString('hex'),
    htm: opts.htm.toUpperCase(),
    htu: opts.htu,
    iat: Math.floor(Date.now() / 1000),
  };

  if (opts.accessToken) {
    // ath = BASE64URL(SHA-256(ASCII(access_token)))  (RFC 9449 §4.2)
    payload.ath = createHash('sha256')
      .update(opts.accessToken, 'ascii')
      .digest('base64url');
  }

  if (opts.nonce) {
    payload.nonce = opts.nonce;
  }

  return new SignJWT(payload)
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'dpop+jwt',
      jwk: publicJwk as Pick<JWK, 'kty' | 'crv' | 'x' | 'y' | 'e' | 'n'>,
    })
    .sign(privateKey);
}
