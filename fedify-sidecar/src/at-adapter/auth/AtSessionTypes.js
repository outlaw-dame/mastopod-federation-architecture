"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
