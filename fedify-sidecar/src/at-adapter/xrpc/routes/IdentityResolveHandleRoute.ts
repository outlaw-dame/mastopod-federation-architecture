/**
 * V6.5 Phase 4: com.atproto.identity.resolveHandle
 *
 * Resolves an ATProto handle to its canonical DID.
 *
 * Security:
 *   - Handle is validated against the ATProto handle grammar before any
 *     lookup is attempted.
 *   - The response body contains only the DID — no internal binding data
 *     is ever forwarded.
 *
 * Ref: https://atproto.com/lexicon/com-atproto-identity#comatprotoidentityresolvehandle
 */

import { HandleResolutionReader, isValidHandle } from '../../identity/HandleResolutionReader';
import { XrpcErrors } from '../middleware/XrpcErrorMapper';

export class IdentityResolveHandleRoute {
  constructor(private readonly handleResolver: HandleResolutionReader) {}

  async handle(handle: string | undefined): Promise<{ headers: Record<string, string>; body: any }> {
    // 1. Validate.
    if (!handle?.trim()) {
      throw XrpcErrors.invalidRequest('handle parameter is required');
    }
    const trimmed = handle.trim().toLowerCase();
    if (!isValidHandle(trimmed)) {
      throw XrpcErrors.invalidHandle(trimmed);
    }

    // 2. Resolve.
    const did = await this.handleResolver.resolveHandle(trimmed);
    if (!did) {
      throw XrpcErrors.handleNotFound(trimmed);
    }

    return {
      headers: {},
      body: { did }
    };
  }
}
