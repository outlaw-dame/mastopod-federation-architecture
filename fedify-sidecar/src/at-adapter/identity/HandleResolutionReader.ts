/**
 * V6.5 Phase 4: Handle Resolution Reader
 *
 * Resolves ATProto handles to DIDs and normalises repo input (handle or DID)
 * for use by XRPC route handlers.
 *
 * Security:
 *   - Handles and DIDs are validated against strict allow-lists before any
 *     lookup is attempted, preventing injection via malformed input.
 *   - All lookups are wrapped in structured error handling so that internal
 *     repository errors never leak to the public XRPC surface.
 *
 * Retry / backoff:
 *   - External DNS/well-known resolution (Phase 5+) will use exponential
 *     backoff with jitter.  The internal identity-binding lookup is a local
 *     store read and does not require backoff in Phase 4.
 */

import { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** ATProto handle grammar: segments of [a-zA-Z0-9-], joined by dots, no
 *  leading/trailing hyphens, total length 1-253 characters.
 *  Ref: https://atproto.com/specs/handle */
const HANDLE_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

/** did:plc and did:web are the only methods we host. */
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]{1,200})$/;

export function isValidHandle(handle: string): boolean {
  if (!handle || handle.length > 253) return false;
  return HANDLE_RE.test(handle);
}

export function isValidDid(did: string): boolean {
  if (!did || did.length > 2048) return false;
  return DID_RE.test(did);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface HandleResolutionReader {
  /**
   * Resolve a handle string to its canonical DID.
   * Returns null if the handle is unknown or invalid.
   */
  resolveHandle(handle: string): Promise<string | null>;

  /**
   * Accept either a DID (starts with "did:") or a handle and return the
   * resolved DID plus the original handle if one was supplied.
   * Returns null if the input cannot be resolved.
   */
  resolveRepoInput(repo: string): Promise<{ did: string; handle?: string } | null>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultHandleResolutionReader implements HandleResolutionReader {
  constructor(private readonly identityRepo: IdentityBindingRepository) {}

  async resolveHandle(handle: string): Promise<string | null> {
    // 1. Sanitise and validate before any I/O.
    const sanitised = handle.trim().toLowerCase();
    if (!isValidHandle(sanitised)) {
      return null;
    }

    try {
      // 2. Look up the binding by handle.
      const binding = await (this.identityRepo.findByHandle
        ? this.identityRepo.findByHandle(sanitised)
        : this.identityRepo.getByAtprotoHandle(sanitised));
      if (!binding) return null;
      if (binding.status !== 'active') return null;
      return binding.atprotoDid ?? null;
    } catch {
      // Swallow internal errors — the public surface must never leak them.
      return null;
    }
  }

  async resolveRepoInput(repo: string): Promise<{ did: string; handle?: string } | null> {
    if (!repo || repo.length > 2048) return null;

    const trimmed = repo.trim();

    if (trimmed.startsWith('did:')) {
      if (!isValidDid(trimmed)) return null;
      return { did: trimmed };
    }

    // Treat as a handle.
    const did = await this.resolveHandle(trimmed);
    if (!did) return null;
    return { did, handle: trimmed };
  }
}
