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
 * Token revocation and refresh replay detection are session-family based.
 * Refresh rotation is durable via the injected SessionFamilyStateStore so
 * replay detection survives restarts and multi-replica deployments.
 *
 * JWT implementation: pure Node.js `crypto` module — no external library.
 * Format: base64url(header) . base64url(payload) . base64url(HMAC-SHA256)
 */

import { createHmac, randomUUID } from 'node:crypto';
import type {
  AtSessionContext,
  AtSessionTokenService,
  AtSessionTokenPair,
} from './AtSessionTypes.js';
import {
  InMemorySessionFamilyStateStore,
  type SessionFamilyRecord,
  type SessionFamilyStateStore,
} from './SessionFamilyStateStore.js';

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

  /**
   * Durable session-family state store for refresh rotation and replay
   * detection. Defaults to an in-memory store for tests and single-process
   * development.
   */
  sessionStateStore?: SessionFamilyStateStore;
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
  /** Stable session family identifier for durable refresh rotation */
  sid?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtSessionTokenService implements AtSessionTokenService {
  private readonly secret: string;
  private readonly accessExpiry: number;
  private readonly refreshExpiry: number;
  private readonly sessionStateStore: SessionFamilyStateStore;

  constructor(config: AtSessionTokenServiceConfig) {
    if (!config.secret || config.secret.length < 32) {
      throw new Error(
        'DefaultAtSessionTokenService: secret must be at least 32 characters'
      );
    }
    this.secret        = config.secret;
    this.accessExpiry  = config.accessExpirySeconds  ?? 7_200;
    this.refreshExpiry = config.refreshExpirySeconds ?? 2_592_000;
    this.sessionStateStore =
      config.sessionStateStore ?? new InMemorySessionFamilyStateStore();
  }

  async mintSessionPair(
    ctx: AtSessionContext
  ): Promise<AtSessionTokenPair & {
    accessTokenId: string;
    refreshTokenId: string;
    sessionFamilyId: string;
  }> {
    const sessionFamilyId = _normalizeOptionalString(ctx.sessionFamilyId) ?? randomUUID();
    const accessTokenId = randomUUID();
    const refreshTokenId = randomUUID();
    const now = new Date().toISOString();

    const family: SessionFamilyRecord = {
      familyId: sessionFamilyId,
      canonicalAccountId: ctx.canonicalAccountId,
      did: ctx.did,
      handle: ctx.handle,
      scope: ctx.scope,
      status: 'active',
      currentRefreshTokenId: refreshTokenId,
      createdAt: now,
      updatedAt: now,
    };

    await this.sessionStateStore.createFamily(family, this.refreshExpiry);

    return {
      accessJwt: this._mint(
        ctx,
        'com.atproto.access',
        this.accessExpiry,
        accessTokenId,
        sessionFamilyId
      ),
      refreshJwt: this._mint(
        ctx,
        'com.atproto.refresh',
        this.refreshExpiry,
        refreshTokenId,
        sessionFamilyId
      ),
      accessTokenId,
      refreshTokenId,
      sessionFamilyId,
    };
  }

  async rotateRefreshSession(
    refreshJwt: string
  ): Promise<(AtSessionTokenPair & {
    accessTokenId: string;
    refreshTokenId: string;
    sessionFamilyId: string;
    previousRefreshTokenId: string;
  }) | null> {
    const claims = this._decodeClaims(refreshJwt, 'com.atproto.refresh');
    if (
      !claims ||
      !_normalizeOptionalString(claims.sid) ||
      !_normalizeOptionalString(claims.canonicalAccountId) ||
      !_normalizeOptionalString(claims.sub) ||
      !_normalizeOptionalString(claims.handle) ||
      !_normalizeOptionalString(claims.jti)
    ) {
      return null;
    }

    const sessionFamilyId = _normalizeOptionalString(claims.sid)!;
    const previousRefreshTokenId = claims.jti;
    const nextRefreshTokenId = randomUUID();
    const rotation = await this.sessionStateStore.rotateFamily(
      sessionFamilyId,
      previousRefreshTokenId,
      nextRefreshTokenId,
      this.refreshExpiry
    );

    if (rotation.kind !== 'rotated') {
      return null;
    }

    const accessTokenId = randomUUID();
    const family = rotation.family;
    const ctx: AtSessionContext = {
      canonicalAccountId: family.canonicalAccountId,
      did: family.did,
      handle: family.handle,
      scope: family.scope,
      sessionFamilyId: family.familyId,
    };

    return {
      accessJwt: this._mint(
        ctx,
        'com.atproto.access',
        this.accessExpiry,
        accessTokenId,
        family.familyId
      ),
      refreshJwt: this._mint(
        ctx,
        'com.atproto.refresh',
        this.refreshExpiry,
        nextRefreshTokenId,
        family.familyId
      ),
      accessTokenId,
      refreshTokenId: nextRefreshTokenId,
      sessionFamilyId: family.familyId,
      previousRefreshTokenId,
    };
  }

  // --------------------------------------------------------------------------
  // AtSessionTokenService interface
  // --------------------------------------------------------------------------

  async mintAccessToken(ctx: AtSessionContext): Promise<string> {
    return this._mint(
      ctx,
      'com.atproto.access',
      this.accessExpiry,
      _normalizeOptionalString(ctx.tokenId) ?? randomUUID(),
      _normalizeOptionalString(ctx.sessionFamilyId)
    );
  }

  async mintRefreshToken(ctx: AtSessionContext): Promise<string> {
    return this._mint(
      ctx,
      'com.atproto.refresh',
      this.refreshExpiry,
      _normalizeOptionalString(ctx.tokenId) ?? randomUUID(),
      _normalizeOptionalString(ctx.sessionFamilyId)
    );
  }

  async verifyAccessToken(jwt: string): Promise<AtSessionContext | null> {
    return this._verify(jwt, 'com.atproto.access');
  }

  async verifyRefreshToken(jwt: string): Promise<AtSessionContext | null> {
    return this._verify(jwt, 'com.atproto.refresh');
  }

  async revokeRefreshToken(jti: string): Promise<void> {
    const normalized = _normalizeOptionalString(jti);
    if (!normalized) return;
    await this.sessionStateStore.revokeFamilyByRefreshTokenId(
      normalized,
      this.refreshExpiry
    );
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private _mint(
    ctx: AtSessionContext,
    scope: string,
    expirySeconds: number,
    tokenId: string,
    sessionFamilyId?: string
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
      jti:               tokenId,
      ...(sessionFamilyId ? { sid: sessionFamilyId } : {}),
    } satisfies Omit<JwtClaims, never>));

    const signingInput = `${header}.${payload}`;
    const sig = createHmac('sha256', this.secret).update(signingInput).digest();
    return `${signingInput}.${_b64url(sig)}`;
  }

  private async _verify(
    jwt: string,
    expectedScope: string
  ): Promise<AtSessionContext | null> {
    const claims = this._decodeClaims(jwt, expectedScope);
    if (
      !claims ||
      !_normalizeOptionalString(claims.sub) ||
      !_normalizeOptionalString(claims.canonicalAccountId) ||
      !_normalizeOptionalString(claims.handle) ||
      !_normalizeOptionalString(claims.jti) ||
      !isPermScope(claims.permScope)
    ) {
      return null;
    }

    const sessionFamilyId = _normalizeOptionalString(claims.sid);
    if (expectedScope === 'com.atproto.refresh') {
      if (!sessionFamilyId) {
        // Pre-durable refresh tokens are rejected to fail closed on replay
        // detection across restarts and replicas. Clients must re-authenticate.
        return null;
      }

      const family = await this.sessionStateStore.getFamily(sessionFamilyId);
      if (!family) {
        return null;
      }

      if (!this._isMatchingActiveFamily(family, claims)) {
        if ((family as SessionFamilyRecord).status === 'active') {
          await this.sessionStateStore.markFamilyCompromised(
            sessionFamilyId,
            this.refreshExpiry
          );
        }
        return null;
      }

      if (family.currentRefreshTokenId !== claims.jti) {
        await this.sessionStateStore.markFamilyCompromised(
          sessionFamilyId,
          this.refreshExpiry
        );
        return null;
      }

      return this._toSessionContext(claims, sessionFamilyId, family.handle);
    }

    if (sessionFamilyId) {
      const family = await this.sessionStateStore.getFamily(sessionFamilyId);
      if (!this._isMatchingActiveFamily(family, claims)) {
        return null;
      }

      return this._toSessionContext(claims, sessionFamilyId, family.handle);
    }

    return this._toSessionContext(claims);
  }

  private _decodeClaims(jwt: string, expectedScope: string): JwtClaims | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;

      const [headerB64, payloadB64, sigB64] = parts;
      const signingInput = `${headerB64}.${payloadB64}`;

      // Constant-time HMAC comparison — prevents timing attacks
      const expected = createHmac('sha256', this.secret).update(signingInput).digest();
      const actual   = Buffer.from(sigB64!, 'base64url');
      if (!_timingSafeEqual(expected, actual)) return null;

      const claims = JSON.parse(
        Buffer.from(payloadB64!, 'base64url').toString('utf8')
      ) as JwtClaims;

      const nowSec = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
      if (typeof claims.iat !== 'number' || claims.iat > nowSec + 60) return null;
      if (claims.scope !== expectedScope) return null;

      return claims;
    } catch {
      return null;
    }
  }

  private _isMatchingActiveFamily(
    family: SessionFamilyRecord | null,
    claims: JwtClaims
  ): family is SessionFamilyRecord {
    return Boolean(
      family &&
        family.status === 'active' &&
        family.canonicalAccountId === claims.canonicalAccountId &&
        family.did === claims.sub
    );
  }

  private _toSessionContext(
    claims: JwtClaims,
    sessionFamilyId?: string,
    fallbackHandle?: string
  ): AtSessionContext {
    return {
      canonicalAccountId: claims.canonicalAccountId,
      did: claims.sub,
      handle: claims.handle || fallbackHandle || '',
      scope: claims.permScope,
      tokenId: claims.jti,
      ...(sessionFamilyId ? { sessionFamilyId } : {}),
    };
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
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

function _normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPermScope(value: unknown): value is AtSessionContext['scope'] {
  return value === 'full' || value === 'app_password_restricted';
}
