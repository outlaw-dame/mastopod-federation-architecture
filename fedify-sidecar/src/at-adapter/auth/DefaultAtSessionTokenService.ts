/**
 * V6.5 Phase 7: Default AT Session Token Service
 *
 * Mints and verifies ATProto-compatible JWTs using HS256 (HMAC-SHA256).
 *
 * ATProto legacy-auth token payload shape:
 *   - Access:  scope "com.atproto.access",  2 h expiry
 *   - Refresh: scope "com.atproto.refresh", 30 d expiry
 *
 * HS256 is used rather than ES256K (secp256k1 per-account signing) because
 * calling the external signing service on every authenticated request adds
 * latency proportional to signing API availability.  For an internal PDS
 * compatibility layer, server-secret HS256 provides adequate security when
 * the secret is rotated regularly and kept out of logs.
 *
 * Token revocation: the in-memory revokedJtis set is suitable for single-
 * process deployments.  Swap for a Redis SET keyed by JTI + TTL for
 * multi-replica deployments.
 *
 * JWT implementation: pure Node.js `crypto` module — no external library.
 * Format: base64url(header) . base64url(payload) . base64url(HMAC-SHA256)
 */

import { createHmac, randomUUID } from 'node:crypto';
import type {
  AtSessionContext,
  AtSessionTokenService,
} from './AtSessionTypes.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AtSessionTokenServiceConfig {
  /**
   * Server-side HS256 signing secret.
   * Must be at least 32 characters.  Treat as a password — never log it.
   */
  secret: string;

  /** Access token lifetime in seconds (default: 7200 = 2 h) */
  accessExpirySeconds?: number;

  /** Refresh token lifetime in seconds (default: 2592000 = 30 d) */
  refreshExpirySeconds?: number;
}

// ---------------------------------------------------------------------------
// JWT claim shape (private)
// ---------------------------------------------------------------------------

interface JwtClaims {
  /** ATProto scope: "com.atproto.access" | "com.atproto.refresh" */
  scope: string;
  /** DID of the account (JWT "sub" claim) */
  sub: string;
  /** Canonical Tier 1 account ID (extended claim) */
  canonicalAccountId: string;
  /** AT handle at time of token issuance (extended claim) */
  handle: string;
  /** Permission scope: "full" | "app_password_restricted" (extended claim) */
  permScope: AtSessionContext['scope'];
  /** Issued-at (UNIX seconds) */
  iat: number;
  /** Expiry (UNIX seconds) */
  exp: number;
  /** Unique token ID for revocation */
  jti: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtSessionTokenService implements AtSessionTokenService {
  private readonly secret: string;
  private readonly accessExpiry: number;
  private readonly refreshExpiry: number;
  /** Revoked refresh token JTIs */
  private readonly revokedJtis = new Set<string>();

  constructor(config: AtSessionTokenServiceConfig) {
    if (!config.secret || config.secret.length < 32) {
      throw new Error(
        'DefaultAtSessionTokenService: secret must be at least 32 characters'
      );
    }
    this.secret        = config.secret;
    this.accessExpiry  = config.accessExpirySeconds  ?? 7_200;
    this.refreshExpiry = config.refreshExpirySeconds ?? 2_592_000;
  }

  // --------------------------------------------------------------------------
  // AtSessionTokenService interface
  // --------------------------------------------------------------------------

  async mintAccessToken(ctx: AtSessionContext): Promise<string> {
    return this._mint(ctx, 'com.atproto.access', this.accessExpiry);
  }

  async mintRefreshToken(ctx: AtSessionContext): Promise<string> {
    return this._mint(ctx, 'com.atproto.refresh', this.refreshExpiry);
  }

  async verifyAccessToken(jwt: string): Promise<AtSessionContext | null> {
    return this._verify(jwt, 'com.atproto.access');
  }

  async verifyRefreshToken(jwt: string): Promise<AtSessionContext | null> {
    return this._verify(jwt, 'com.atproto.refresh');
  }

  async revokeRefreshToken(jti: string): Promise<void> {
    this.revokedJtis.add(jti);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private _mint(
    ctx: AtSessionContext,
    scope: string,
    expirySeconds: number
  ): string {
    const now = Math.floor(Date.now() / 1000);
    // ATProto XRPC spec: access tokens use typ "at+jwt"; refresh tokens use "refresh+jwt"
    const typ = scope === 'com.atproto.access' ? 'at+jwt' : 'refresh+jwt';
    const header  = _b64url(JSON.stringify({ alg: 'HS256', typ }));
    const payload = _b64url(JSON.stringify({
      scope,
      sub:               ctx.did,
      canonicalAccountId: ctx.canonicalAccountId,
      handle:            ctx.handle,
      permScope:         ctx.scope,
      iat:               now,
      exp:               now + expirySeconds,
      jti:               randomUUID(),
    } satisfies Omit<JwtClaims, never>));

    const signingInput = `${header}.${payload}`;
    const sig = createHmac('sha256', this.secret).update(signingInput).digest();
    return `${signingInput}.${_b64url(sig)}`;
  }

  private _verify(jwt: string, expectedScope: string): AtSessionContext | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;

      const [headerB64, payloadB64, sigB64] = parts;
      const signingInput = `${headerB64}.${payloadB64}`;

      // Constant-time HMAC comparison — prevents timing attacks
      const expected = createHmac('sha256', this.secret).update(signingInput).digest();
      const actual   = Buffer.from(sigB64, 'base64url');
      if (!_timingSafeEqual(expected, actual)) return null;

      const claims = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8')
      ) as JwtClaims;

      const nowSec = Math.floor(Date.now() / 1000);
      if (claims.exp < nowSec)                     return null;
      if (claims.scope !== expectedScope)           return null;
      if (this.revokedJtis.has(claims.jti))        return null;
      if (!claims.sub || !claims.canonicalAccountId) return null;

      return {
        canonicalAccountId: claims.canonicalAccountId,
        did:    claims.sub,
        handle: claims.handle ?? '',
        scope:  claims.permScope ?? 'full',
      };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

function _b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

/**
 * Constant-time buffer comparison.
 * Node 15+ has `crypto.timingSafeEqual` but it throws on length mismatch —
 * we handle that case explicitly.
 */
function _timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
