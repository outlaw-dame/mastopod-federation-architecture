import { request } from 'undici';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';

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
  timeoutMs?: number;
}

export class HttpIdentityBindingSyncService implements IdentityBindingSyncService {
  private readonly backendBaseUrl: string;
  private readonly bearerToken: string;
  private readonly identityBindingRepository: IdentityBindingRepository;
  private readonly timeoutMs: number;

  constructor(config: IdentityBindingSyncServiceConfig) {
    this.backendBaseUrl = config.backendBaseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
    this.identityBindingRepository = config.identityBindingRepository;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async syncByCanonicalAccountId(canonicalAccountId: string): Promise<boolean> {
    const path =
      '/api/internal/identity/by-canonical-account-id?canonicalAccountId=' +
      encodeURIComponent(canonicalAccountId);
    return this.fetchAndUpsert(path);
  }

  async syncByDid(did: string): Promise<boolean> {
    const path = '/api/internal/identity/by-did?did=' + encodeURIComponent(did);
    return this.fetchAndUpsert(path);
  }

  async syncByHandle(handle: string): Promise<boolean> {
    const path = '/api/internal/identity/by-handle?handle=' + encodeURIComponent(handle.toLowerCase());
    return this.fetchAndUpsert(path);
  }

  private async fetchAndUpsert(path: string): Promise<boolean> {
    const res = await request(`${this.backendBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
      },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });

    if (res.statusCode === 404) return false;

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`Identity sync failed (${res.statusCode}): ${body}`);
    }

    const payload = (await res.body.json()) as BackendIdentityProjection | null;
    if (!payload) return false;

    await this.identityBindingRepository.upsert(this.toIdentityBinding(payload));
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
