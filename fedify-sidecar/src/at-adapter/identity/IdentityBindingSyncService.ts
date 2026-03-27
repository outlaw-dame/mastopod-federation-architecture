import { request } from 'undici';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import { traceIdentitySync, type IdentitySyncLogger } from './IdentitySyncTrace.js';

export interface BackendIdentityProjection {
  canonicalAccountId: string;
  webId: string;
  activityPubActorId?: string | null;
  activityPubHandle?: string | null;
  atprotoDid: string;
  atprotoHandle: string;
  atSigningKeyRef: string;
  atRotationKeyRef: string;
  status: 'pending' | 'active' | 'disabled';
  createdAt?: string;
  updatedAt?: string;
}

export interface IdentityBindingSyncService {
  syncByCanonicalAccountId(canonicalAccountId: string): Promise<boolean>;
  syncByDid(did: string): Promise<boolean>;
  syncByHandle(handle: string): Promise<boolean>;
}

export interface IdentityBindingSyncServiceConfig {
  backendBaseUrl: string;
  bearerToken: string;
  identityBindingRepository: IdentityBindingRepository;
  logger?: IdentitySyncLogger;
  timeoutMs?: number;
}

export class HttpIdentityBindingSyncService implements IdentityBindingSyncService {
  private readonly backendBaseUrl: string;
  private readonly bearerToken: string;
  private readonly identityBindingRepository: IdentityBindingRepository;
  private readonly logger?: IdentitySyncLogger;
  private readonly timeoutMs: number;

  constructor(config: IdentityBindingSyncServiceConfig) {
    this.backendBaseUrl = config.backendBaseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
    this.identityBindingRepository = config.identityBindingRepository;
    this.logger = config.logger;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async syncByCanonicalAccountId(canonicalAccountId: string): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'syncByCanonicalAccountId:start', {
      canonicalAccountId,
    });

    const path =
      '/api/internal/identity/by-canonical-account-id?canonicalAccountId=' +
      encodeURIComponent(canonicalAccountId);
    return this.fetchAndUpsert(path, {
      syncType: 'canonicalAccountId',
      canonicalAccountId,
    });
  }

  async syncByDid(did: string): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'syncByDid:start', { did });
    const path = '/api/internal/identity/by-did?did=' + encodeURIComponent(did);
    return this.fetchAndUpsert(path, {
      syncType: 'did',
      did,
    });
  }

  async syncByHandle(handle: string): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'syncByHandle:start', { handle });
    const path = '/api/internal/identity/by-handle?handle=' + encodeURIComponent(handle.toLowerCase());
    return this.fetchAndUpsert(path, {
      syncType: 'handle',
      handle,
    });
  }

  private async fetchAndUpsert(
    path: string,
    meta: Record<string, unknown>
  ): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'fetch:start', {
      ...meta,
      path,
    });

    const res = await request(`${this.backendBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
      },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });

    if (res.statusCode === 404) {
      traceIdentitySync(this.logger, 'info', 'fetch:not-found', {
        ...meta,
        path,
        status: res.statusCode,
      });
      return false;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      traceIdentitySync(this.logger, 'warn', 'fetch:failed', {
        ...meta,
        path,
        status: res.statusCode,
        body,
      });
      throw new Error(`Identity sync failed (${res.statusCode}): ${body}`);
    }

    const payload = (await res.body.json()) as BackendIdentityProjection | null;
    if (!payload) {
      traceIdentitySync(this.logger, 'warn', 'fetch:empty-payload', {
        ...meta,
        path,
      });
      return false;
    }

    traceIdentitySync(this.logger, 'info', 'fetch:success', {
      ...meta,
      canonicalAccountId: payload.canonicalAccountId,
      did: payload.atprotoDid,
      handle: payload.atprotoHandle,
    });

    await this.identityBindingRepository.upsert(this.toIdentityBinding(payload));

    traceIdentitySync(this.logger, 'info', 'upsert:success', {
      ...meta,
      canonicalAccountId: payload.canonicalAccountId,
      did: payload.atprotoDid,
      handle: payload.atprotoHandle,
    });

    return true;
  }

  private toIdentityBinding(payload: BackendIdentityProjection): IdentityBinding {
    const now = new Date().toISOString();

    return {
      canonicalAccountId: payload.canonicalAccountId,
      contextId: 'default',
      webId: payload.webId,
      activityPubActorUri: payload.activityPubActorId ?? payload.webId,
      atprotoDid: payload.atprotoDid,
      atprotoHandle: payload.atprotoHandle,
      canonicalDidMethod: null,
      atprotoPdsEndpoint: null,
      apSigningKeyRef: payload.atSigningKeyRef || payload.atRotationKeyRef || `${payload.canonicalAccountId}#ap-signing`,
      atSigningKeyRef: payload.atSigningKeyRef,
      atRotationKeyRef: payload.atRotationKeyRef,
      plc: {
        opCid: null,
        rotationKeyRef: payload.atRotationKeyRef,
        plcUpdateState: null,
        lastSubmittedAt: null,
        lastConfirmedAt: null,
        lastError: null,
      },
      didWeb: null,
      accountLinks: {
        apAlsoKnownAs: [],
        atAlsoKnownAs: [],
        relMe: [],
        webIdSameAs: [],
        webIdAccounts: [],
      },
      status: this.toLocalStatus(payload.status),
      createdAt: payload.createdAt ?? now,
      updatedAt: payload.updatedAt ?? now,
    };
  }

  private toLocalStatus(status: BackendIdentityProjection['status']): IdentityBinding['status'] {
    if (status === 'active') return 'active';
    if (status === 'disabled') return 'suspended';
    return 'suspended';
  }
}

export { HttpIdentityBindingSyncService as IdentityBindingSyncServiceImpl };
