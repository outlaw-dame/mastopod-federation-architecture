/**
 * V6.5 Phase 7: Default AT Session Service
 *
 * Thin orchestrator for the com.atproto.server.createSession flow:
 *
 *   1. Resolve AT identifier (handle or DID) → canonical account via AtAccountResolver
 *   2. Verify password / app-password via AtPasswordVerifier
 *   3. Mint access + refresh JWTs via AtSessionTokenService
 *   4. Return Lexicon-compliant AtSessionCreateResult
 *
 * Design rule: account identity lives entirely in the canonical store.
 * This service never writes to a separate AT user table.  All auth state
 * is derived from IdentityBinding via AtAccountResolver.
 *
 * Error policy: both "account not found" and "wrong password" return the
 * same 401 AuthRequired response to prevent user enumeration.
 */

import { XrpcErrors } from '../xrpc/middleware/XrpcErrorMapper.js';
import type {
  AtSessionService,
  AtAccountResolver,
  AtPasswordVerifier,
  AtSessionTokenService,
  AtSessionContext,
  AtSessionCreateResult,
} from './AtSessionTypes.js';

export class DefaultAtSessionService implements AtSessionService {
  constructor(
    private readonly accountResolver: AtAccountResolver,
    private readonly passwordVerifier: AtPasswordVerifier,
    private readonly tokenService: AtSessionTokenService
  ) {}

  // --------------------------------------------------------------------------
  // AtSessionService interface
  // --------------------------------------------------------------------------

  async createSession(
    identifier: string,
    password: string
  ): Promise<AtSessionCreateResult> {
    const account = await this.accountResolver.resolveByIdentifier(identifier);
    if (!account) {
      // Same message for unknown identifier and wrong password — no enumeration
      throw XrpcErrors.authRequired('Invalid identifier or password');
    }

    let scope: AtSessionContext['scope'];
    try {
      scope = await this.passwordVerifier.verify(account.canonicalAccountId, password);
    } catch {
      throw XrpcErrors.authRequired('Invalid identifier or password');
    }

    const ctx: AtSessionContext = {
      canonicalAccountId: account.canonicalAccountId,
      did:    account.did,
      handle: account.handle,
      scope,
    };

    const [accessJwt, refreshJwt] = await Promise.all([
      this.tokenService.mintAccessToken(ctx),
      this.tokenService.mintRefreshToken(ctx),
    ]);

    return {
      did:       account.did,
      handle:    account.handle,
      accessJwt,
      refreshJwt,
      active:    true,
    };
  }

  async verifyAccessToken(jwt: string): Promise<AtSessionContext | null> {
    return this.tokenService.verifyAccessToken(jwt);
  }

  async mintAccessToken(ctx: AtSessionContext): Promise<string> {
    return this.tokenService.mintAccessToken(ctx);
  }

  async mintRefreshToken(ctx: AtSessionContext): Promise<string> {
    return this.tokenService.mintRefreshToken(ctx);
  }
}
