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
import type { AtSessionService } from '../../auth/AtSessionTypes.js';

export class ServerCreateSessionRoute {
  constructor(private readonly sessionService: AtSessionService) {}

  async handle(
    body: Record<string, unknown> | undefined
  ): Promise<{ headers: Record<string, string>; body: unknown }> {
    const identifier = body?.["identifier"];
    const password = body?.["password"];

    if (!identifier || typeof identifier !== 'string') {
      throw XrpcErrors.invalidRequest('identifier is required');
    }
    if (!password || typeof password !== 'string') {
      throw XrpcErrors.invalidRequest('password is required');
    }

    const result = await this.sessionService.createSession(identifier.trim(), password);

    return {
      headers: { 'Content-Type': 'application/json' },
      body: result,
    };
  }
}
