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

import { XrpcError, XrpcErrors } from '../xrpc/middleware/XrpcErrorMapper.js';
import type {
  AtSessionService,
  AtAccountResolver,
  AtPasswordVerifier,
  AtSessionTokenService,
  AtSessionContext,
  AtSessionCreateResult,
  ResolvedAtAccount,
} from './AtSessionTypes.js';
import type { ExternalAtSessionStore, StoredExternalAtSession } from '../external/ExternalAtSessionStore.js';
import {
  ExternalPdsClient,
  ExternalPdsClientError,
} from '../external/ExternalPdsClient.js';

type MintedLocalSession = {
  accessJwt: string;
  refreshJwt: string;
  accessTokenId: string;
  refreshTokenId: string;
  sessionFamilyId: string;
};

export class DefaultAtSessionService implements AtSessionService {
  constructor(
    private readonly accountResolver: AtAccountResolver,
    private readonly passwordVerifier: AtPasswordVerifier,
    private readonly tokenService: AtSessionTokenService,
    private readonly externalPdsClient?: ExternalPdsClient,
    private readonly externalSessionStore?: ExternalAtSessionStore
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

    if (!account.atprotoManaged) {
      return this.createExternalSession(account, identifier, password);
    }

    let scope: AtSessionContext['scope'];
    try {
      scope = await this.passwordVerifier.verify(account.canonicalAccountId, password);
    } catch {
      throw XrpcErrors.authRequired('Invalid identifier or password');
    }

    const local = await this.mintLocalSession({
      canonicalAccountId: account.canonicalAccountId,
      did:    account.did,
      handle: account.handle,
      scope,
    });

    return {
      did: local.did,
      handle: local.handle,
      accessJwt: local.accessJwt,
      refreshJwt: local.refreshJwt,
      active: local.active,
    };
  }

  async refreshSession(refreshJwt: string): Promise<AtSessionCreateResult> {
    const existing = await this.tokenService.verifyRefreshToken(refreshJwt);
    if (!existing?.tokenId) {
      throw XrpcErrors.authRequired('Invalid or expired refresh token');
    }

    const account = await this.accountResolver.resolveByIdentifier(existing.did);
    if (!account) {
      await this.safeRevokeRefreshToken(existing.tokenId);
      throw XrpcErrors.authRequired('Invalid or expired refresh token');
    }

    if (!account.atprotoManaged) {
      const rotated = await this.refreshExternalSession(
        account,
        refreshJwt,
        existing.tokenId
      );
      return {
        did: account.did,
        handle: account.handle,
        accessJwt: rotated.accessJwt,
        refreshJwt: rotated.refreshJwt,
        active: true,
      };
    }

    const local = await this.rotateLocalSession(refreshJwt);

    return {
      did: account.did,
      handle: account.handle,
      accessJwt: local.accessJwt,
      refreshJwt: local.refreshJwt,
      active: true,
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

  private async mintLocalSession(
    ctx: AtSessionContext
  ): Promise<AtSessionCreateResult & MintedLocalSession> {
    const minted = await this.tokenService.mintSessionPair(ctx);

    return {
      did: ctx.did,
      handle: ctx.handle,
      accessJwt: minted.accessJwt,
      refreshJwt: minted.refreshJwt,
      active: true,
      accessTokenId: minted.accessTokenId,
      refreshTokenId: minted.refreshTokenId,
      sessionFamilyId: minted.sessionFamilyId,
    };
  }

  private async createExternalSession(
    account: ResolvedAtAccount,
    identifier: string,
    password: string
  ): Promise<AtSessionCreateResult> {
    if (!this.externalPdsClient || !this.externalSessionStore || !account.atprotoPdsUrl) {
      throw XrpcErrors.authRequired('Invalid identifier or password');
    }

    try {
      const upstream = await this.externalPdsClient.createSession(
        account.atprotoPdsUrl,
        identifier,
        password
      );

      if (upstream.did !== account.did) {
        throw XrpcErrors.authRequired('Invalid identifier or password');
      }

      if (upstream.handle && upstream.handle !== account.handle) {
        throw XrpcErrors.authRequired('Invalid identifier or password');
      }

      const local = await this.mintLocalSession({
        canonicalAccountId: account.canonicalAccountId,
        did: account.did,
        handle: account.handle,
        scope: 'full',
      });

      const stored: StoredExternalAtSession = {
        canonicalAccountId: account.canonicalAccountId,
        did: account.did,
        handle: account.handle,
        pdsUrl: account.atprotoPdsUrl,
        accessJwt: upstream.accessJwt,
        refreshJwt: upstream.refreshJwt,
        createdAt: new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
        accessTokenId: local.accessTokenId,
        refreshTokenId: local.refreshTokenId,
      };

      await this.writeExternalSessionAliases(
        [local.accessTokenId, local.refreshTokenId],
        stored
      );

      return {
        did: account.did,
        handle: account.handle,
        accessJwt: local.accessJwt,
        refreshJwt: local.refreshJwt,
        active: true,
      };
    } catch (error) {
      if (error instanceof ExternalPdsClientError) {
        if (error.status === 400 || error.status === 401 || error.status === 403) {
          throw XrpcErrors.authRequired('Invalid identifier or password');
        }

        throw new XrpcError(
          503,
          'InternalServerError',
          'External AT identity provider is temporarily unavailable'
        );
      }

      throw error;
    }
  }

  private async refreshExternalSession(
    account: ResolvedAtAccount,
    refreshJwt: string,
    refreshTokenId: string
  ): Promise<AtSessionCreateResult & MintedLocalSession> {
    if (!this.externalPdsClient || !this.externalSessionStore || !account.atprotoPdsUrl) {
      throw XrpcErrors.authRequired('Invalid or expired refresh token');
    }

    const stored = await this.externalSessionStore.get(refreshTokenId);
    if (!stored?.refreshJwt) {
      await this.safeRevokeRefreshToken(refreshTokenId);
      throw XrpcErrors.authRequired('Invalid or expired refresh token');
    }

    try {
      const upstream = await this.externalPdsClient.refreshSession(
        account.atprotoPdsUrl,
        stored.refreshJwt
      );

      if (upstream.did !== account.did) {
        await this.deleteExternalSessionAliases(stored);
        await this.safeRevokeRefreshToken(refreshTokenId);
        throw XrpcErrors.authRequired('External AT session no longer matches the linked DID');
      }

      if (upstream.handle && upstream.handle !== account.handle) {
        await this.deleteExternalSessionAliases(stored);
        await this.safeRevokeRefreshToken(refreshTokenId);
        throw XrpcErrors.authRequired('External AT session no longer matches the linked handle');
      }

      const local = await this.rotateLocalSession(refreshJwt);

      const refreshed: StoredExternalAtSession = {
        ...stored,
        handle: account.handle,
        pdsUrl: account.atprotoPdsUrl,
        accessJwt: upstream.accessJwt,
        refreshJwt: upstream.refreshJwt ?? stored.refreshJwt,
        refreshedAt: new Date().toISOString(),
        accessTokenId: local.accessTokenId,
        refreshTokenId: local.refreshTokenId,
      };

      await this.externalSessionStore.delete(refreshTokenId);
      await this.writeExternalSessionAliases(
        [stored.accessTokenId, local.accessTokenId, local.refreshTokenId],
        refreshed
      );

      return {
        did: account.did,
        handle: account.handle,
        accessJwt: local.accessJwt,
        refreshJwt: local.refreshJwt,
        active: true,
        accessTokenId: local.accessTokenId,
        refreshTokenId: local.refreshTokenId,
        sessionFamilyId: local.sessionFamilyId,
      };
    } catch (error) {
      if (error instanceof ExternalPdsClientError) {
        if (error.status === 400 || error.status === 401 || error.status === 403) {
          await this.safeRevokeRefreshToken(refreshTokenId);
          throw XrpcErrors.authRequired('Invalid or expired refresh token');
        }

        throw new XrpcError(
          503,
          'InternalServerError',
          'External AT identity provider is temporarily unavailable'
        );
      }

      throw error;
    }
  }

  private async rotateLocalSession(
    refreshJwt: string
  ): Promise<MintedLocalSession> {
    try {
      const rotated = await this.tokenService.rotateRefreshSession(refreshJwt);
      if (!rotated) {
        throw XrpcErrors.authRequired('Invalid or expired refresh token');
      }

      return {
        accessJwt: rotated.accessJwt,
        refreshJwt: rotated.refreshJwt,
        accessTokenId: rotated.accessTokenId,
        refreshTokenId: rotated.refreshTokenId,
        sessionFamilyId: rotated.sessionFamilyId,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'SESSION_FAMILY_LOCKED') {
        throw new XrpcError(
          503,
          'InternalServerError',
          'Session refresh is already in progress; retry the request'
        );
      }

      throw error;
    }
  }

  private async safeRevokeRefreshToken(refreshTokenId: string): Promise<void> {
    try {
      await this.tokenService.revokeRefreshToken(refreshTokenId);
    } catch {
      // Fail closed on the caller path while avoiding a best-effort revoke
      // failure masking the primary auth outcome.
    }
  }

  private async writeExternalSessionAliases(
    aliases: Array<string | undefined>,
    value: StoredExternalAtSession
  ): Promise<void> {
    const keys = [...new Set(aliases.filter((key): key is string => typeof key === 'string' && key.trim().length > 0))];
    await Promise.all(keys.map((key) => this.externalSessionStore!.put(key, value)));
  }

  private async deleteExternalSessionAliases(value: StoredExternalAtSession): Promise<void> {
    const aliases = [value.accessTokenId, value.refreshTokenId].filter(
      (key): key is string => typeof key === 'string' && key.trim().length > 0
    );
    await Promise.all(aliases.map((key) => this.externalSessionStore!.delete(key)));
  }
}
