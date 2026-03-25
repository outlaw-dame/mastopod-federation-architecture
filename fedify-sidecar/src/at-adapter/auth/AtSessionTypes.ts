/**
 * V6.5 Phase 7: ATProto Session Types
 *
 * Defines the session/auth contract for the XRPC write surface.
 *
 * Design rule: AT session tokens are a compatibility layer over canonical
 * account identity.  They are NOT a separate account store — all identities
 * are resolved through IdentityBinding.  The session layer only mints
 * short-lived tokens compatible with the ATProto legacy-auth spec.
 *
 * Ref: https://atproto.com/specs/xrpc (legacy bearer/JWT auth)
 */

// ---------------------------------------------------------------------------
// Session context (decoded from a valid access token)
// ---------------------------------------------------------------------------

/**
 * Decoded context attached to every authenticated XRPC request.
 * Populated by AtSessionTokenService.verifyAccessToken and stored on the
 * request object for downstream route handlers.
 */
export interface AtSessionContext {
  /** Canonical Tier 1 account identifier */
  canonicalAccountId: string;

  /** ATProto DID of the account (did:plc or did:web) */
  did: string;

  /** AT handle, e.g. alice.pods.example */
  handle: string;

  /**
   * Scope of access:
   * - 'full'                   : primary credentials (full write access)
   * - 'app_password_restricted': app-password credential (limited write access)
   */
  scope: 'full' | 'app_password_restricted';
}

// ---------------------------------------------------------------------------
// Token pair (returned by createSession)
// ---------------------------------------------------------------------------

export interface AtSessionTokenPair {
  /** Short-lived JWT, signed by the account's AT signing key */
  accessJwt: string;
  /** Longer-lived refresh JWT */
  refreshJwt: string;
}

// ---------------------------------------------------------------------------
// com.atproto.server.createSession response shape (Lexicon-matching)
// ---------------------------------------------------------------------------

export interface AtSessionCreateResult extends AtSessionTokenPair {
  /** DID of the authenticated account */
  did: string;
  /** Handle at time of login */
  handle: string;
  /** Email address if available */
  email?: string;
  /** Whether email has been confirmed */
  emailConfirmed?: boolean;
  /** false when the account is deactivated/suspended */
  active?: boolean;
  /** Human-readable status detail when active=false */
  status?: string;
  /** DID document returned inline per some client expectations */
  didDoc?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Session service interface
// ---------------------------------------------------------------------------

export interface AtSessionService {
  /**
   * Authenticate with identifier (handle or DID) + password / app-password.
   * Resolves through canonical account store, NOT a separate AT user table.
   * Throws on invalid credentials.
   */
  createSession(
    identifier: string,
    password: string
  ): Promise<AtSessionCreateResult>;

  /**
   * Validate and decode an access JWT.
   * Returns null if the token is invalid, expired, or revoked.
   */
  verifyAccessToken(jwt: string): Promise<AtSessionContext | null>;

  /**
   * Mint a new access JWT for an authenticated session context.
   * Token is signed using the account's AT signing key via the Signing API.
   */
  mintAccessToken(ctx: AtSessionContext): Promise<string>;

  /**
   * Mint a new refresh JWT for an authenticated session context.
   */
  mintRefreshToken(ctx: AtSessionContext): Promise<string>;
}

// ---------------------------------------------------------------------------
// Account resolver interface (identifier → canonical account)
// ---------------------------------------------------------------------------

export interface AtAccountResolver {
  /**
   * Resolve an AT identifier (handle or DID string) to the canonical account.
   * Returns null when the account does not exist or is not hosted here.
   */
  resolveByIdentifier(identifier: string): Promise<{
    canonicalAccountId: string;
    did: string;
    handle: string;
  } | null>;
}

// ---------------------------------------------------------------------------
// Password verifier interface (canonical account auth)
// ---------------------------------------------------------------------------

export interface AtPasswordVerifier {
  /**
   * Verify a password or app-password against the canonical account store.
   * Returns the scope granted by this credential.
   * Throws on wrong password.
   */
  verify(
    canonicalAccountId: string,
    password: string
  ): Promise<AtSessionContext['scope']>;
}

// ---------------------------------------------------------------------------
// Token service interface (JWT lifecycle management)
// ---------------------------------------------------------------------------

export interface AtSessionTokenService {
  mintAccessToken(ctx: AtSessionContext): Promise<string>;
  mintRefreshToken(ctx: AtSessionContext): Promise<string>;
  verifyAccessToken(jwt: string): Promise<AtSessionContext | null>;
  verifyRefreshToken(jwt: string): Promise<AtSessionContext | null>;
  revokeRefreshToken(jti: string): Promise<void>;
}
