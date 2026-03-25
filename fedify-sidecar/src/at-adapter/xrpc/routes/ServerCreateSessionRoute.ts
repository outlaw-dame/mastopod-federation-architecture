/**
 * V6.5 Phase 7: com.atproto.server.createSession
 *
 * Legacy bearer/JWT authentication for AT clients.
 * Accepts an account identifier (handle or DID) + password/app-password,
 * verifies credentials against the canonical account store, and returns
 * an ATProto-compatible access + refresh JWT pair.
 *
 * Design rule: credentials are verified through AtPasswordVerifier, which
 * delegates to the existing canonical account auth layer.  This route does
 * NOT maintain a separate AT-native user table.
 *
 * The access JWT is signed using the account's AT signing key via the
 * Signing API (secp256k1 / k256), making it verifiable against the DID doc.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-server#comatprotoservercreatesession
 */

import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';
import type { AtAccountResolver, AtPasswordVerifier, AtSessionService } from '../../auth/AtSessionTypes.js';

export class ServerCreateSessionRoute {
  constructor(
    private readonly accountResolver: AtAccountResolver,
    private readonly passwordVerifier: AtPasswordVerifier,
    private readonly sessionService: AtSessionService
  ) {}

  async handle(
    body: Record<string, unknown> | undefined
  ): Promise<{ headers: Record<string, string>; body: unknown }> {
    const identifier = body?.identifier;
    const password = body?.password;

    if (!identifier || typeof identifier !== 'string') {
      throw XrpcErrors.invalidRequest('identifier is required');
    }
    if (!password || typeof password !== 'string') {
      throw XrpcErrors.invalidRequest('password is required');
    }

    // Resolve identifier (handle or DID) → canonical account
    const account = await this.accountResolver.resolveByIdentifier(identifier.trim());
    if (!account) {
      throw XrpcErrors.authRequired('Account not found or not hosted here');
    }

    // Verify password / app-password against canonical auth layer
    // Throws XrpcError(401) on wrong password
    try {
      await this.passwordVerifier.verify(account.canonicalAccountId, password);
    } catch (err: any) {
      if (err?.status === 401 || err?.code === 'WRONG_PASSWORD' || err?.code === 'AUTH_FAILED') {
        throw XrpcErrors.authRequired('Invalid credentials');
      }
      throw err;
    }

    // Mint session via the session service (which calls the Signing API)
    const result = await this.sessionService.createSession(identifier.trim(), password);

    return {
      headers: { 'Content-Type': 'application/json' },
      body: result,
    };
  }
}
