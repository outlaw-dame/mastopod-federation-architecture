import { XrpcError, XrpcErrors, type XrpcErrorName } from '../xrpc/middleware/XrpcErrorMapper.js';
import type { ExternalAtSessionStore, StoredExternalAtSession } from './ExternalAtSessionStore.js';
import {
  ExternalPdsClient,
  ExternalPdsClientError,
  type ExternalPdsResponse,
} from './ExternalPdsClient.js';

export class ExternalWriteGateway {
  constructor(
    private readonly externalPdsClient: ExternalPdsClient,
    private readonly externalSessionStore: ExternalAtSessionStore,
    /**
     * The OAuth client_id registered for this sidecar instance.  Required only
     * for DPoP-bound sessions (accounts linked via ATProto OAuth). Falls back
     * to an empty string which is safe for password-linked accounts.
     */
    private readonly oauthClientId: string = '',
  ) {}

  async createRecord(localSessionTokenId: string, body: unknown): Promise<unknown> {
    const response = await this.executeWithSessionRefresh(
      localSessionTokenId,
      body,
      (session) =>
        this.externalPdsClient.createRecord(
          session.pdsUrl,
          session.accessJwt,
          body,
          session.dpopPrivateKeyJwk,
        )
    );
    return response.body;
  }

  async putRecord(localSessionTokenId: string, body: unknown): Promise<unknown> {
    const response = await this.executeWithSessionRefresh(
      localSessionTokenId,
      body,
      (session) =>
        this.externalPdsClient.putRecord(
          session.pdsUrl,
          session.accessJwt,
          body,
          session.dpopPrivateKeyJwk,
        )
    );
    return response.body;
  }

  async deleteRecord(localSessionTokenId: string, body: unknown): Promise<unknown> {
    const response = await this.executeWithSessionRefresh(
      localSessionTokenId,
      body,
      (session) =>
        this.externalPdsClient.deleteRecord(
          session.pdsUrl,
          session.accessJwt,
          body,
          session.dpopPrivateKeyJwk,
        )
    );
    return response.body;
  }

  private async executeWithSessionRefresh(
    localSessionTokenId: string,
    body: unknown,
    fn: (session: StoredExternalAtSession) => Promise<ExternalPdsResponse<unknown>>
  ): Promise<ExternalPdsResponse<unknown>> {
    let session = await this.requireSession(localSessionTokenId);
    assertRepoOwnership(body, session);

    try {
      return await fn(session);
    } catch (error) {
      if (!shouldRefreshUpstreamSession(error) || !session.refreshJwt) {
        throw mapExternalError(error);
      }

      // Choose refresh path: OAuth token endpoint (DPoP-bound) or legacy XRPC
      let refreshed: { did: string; handle?: string; accessJwt: string; refreshJwt?: string };

      if (session.dpopPrivateKeyJwk && session.tokenEndpoint) {
        // ATProto OAuth path: DPoP-bound token refresh via token endpoint
        refreshed = await this.externalPdsClient.refreshSessionOAuth(
          session.tokenEndpoint,
          session.refreshJwt,
          session.dpopPrivateKeyJwk,
          this.oauthClientId,
        );
      } else {
        // Legacy path: password-linked accounts use the XRPC refreshSession route
        refreshed = await this.externalPdsClient.refreshSession(
          session.pdsUrl,
          session.refreshJwt
        );
      }

      if (refreshed.did !== session.did) {
        await this.externalSessionStore.delete(localSessionTokenId);
        throw XrpcErrors.authRequired('External AT session no longer matches the linked DID');
      }

      if (refreshed.handle && refreshed.handle !== session.handle) {
        await this.externalSessionStore.delete(localSessionTokenId);
        throw XrpcErrors.authRequired('External AT session no longer matches the linked handle');
      }

      session = {
        ...session,
        accessJwt: refreshed.accessJwt,
        refreshJwt: refreshed.refreshJwt ?? session.refreshJwt,
      };

      await this.externalSessionStore.put(localSessionTokenId, session);
      try {
        return await fn(session);
      } catch (retryError) {
        throw mapExternalError(retryError);
      }
    }
  }

  private async requireSession(localSessionTokenId: string): Promise<StoredExternalAtSession> {
    const session = await this.externalSessionStore.get(localSessionTokenId);
    if (!session) {
      throw XrpcErrors.authRequired('External AT session not found');
    }
    return session;
  }
}

function assertRepoOwnership(body: unknown, session: StoredExternalAtSession): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;

  const repo = (body as Record<string, unknown>)["repo"];
  if (typeof repo !== 'string') return;

  const normalizedRepo = repo.trim().toLowerCase();
  if (
    normalizedRepo !== session.did.toLowerCase() &&
    normalizedRepo !== session.handle.toLowerCase()
  ) {
    throw XrpcErrors.forbidden(`Cannot write to repo ${repo}: not the authenticated account`);
  }
}

function shouldRefreshUpstreamSession(error: unknown): boolean {
  return (
    error instanceof ExternalPdsClientError &&
    (error.status === 401 || error.status === 403)
  );
}

function mapExternalError(error: unknown): Error {
  if (!(error instanceof ExternalPdsClientError)) {
    return XrpcErrors.internal();
  }

  if (error.error && isKnownXrpcErrorName(error.error)) {
    return new XrpcError(
      error.status ?? 500,
      error.error,
      error.message || 'External PDS request failed'
    );
  }

  if (error.status === 400) {
    if (error.error === 'InvalidSwap') {
      return XrpcErrors.invalidSwap(error.message);
    }
    return XrpcErrors.invalidRequest(error.message);
  }

  if (error.status === 401 || error.status === 403) {
    return XrpcErrors.authRequired('External AT session is invalid or expired');
  }

  if (error.status === 404) {
    return XrpcErrors.repoNotFound('external');
  }

  if (error.status === 409) {
    return XrpcErrors.writeNotAllowed(error.message);
  }

  if (error.status === 429 || (error.status !== undefined && error.status >= 500)) {
    return XrpcErrors.writeTimeout();
  }

  return XrpcErrors.internal();
}

function isKnownXrpcErrorName(value: string): value is XrpcErrorName {
  return new Set<XrpcErrorName>([
    'InvalidRequest',
    'NotFound',
    'RepoNotFound',
    'RecordNotFound',
    'HandleNotFound',
    'InvalidDid',
    'InvalidHandle',
    'InvalidCursor',
    'InvalidCollection',
    'InvalidRkey',
    'RepoDeactivated',
    'RepoTakendown',
    'UnsupportedAlgorithm',
    'InternalServerError',
    'AuthRequired',
    'Forbidden',
    'UnsupportedCollection',
    'WriteNotAllowed',
    'WriteTimeout',
    'InvalidSwap',
  ]).has(value as XrpcErrorName);
}
