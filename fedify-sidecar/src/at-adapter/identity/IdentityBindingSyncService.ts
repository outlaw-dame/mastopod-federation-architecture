import { request } from 'undici';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import {
  buildInternalIdentityProjectionPathByDid,
  buildInternalIdentityProjectionPathByHandle,
  buildInternalIdentityProjectionPathsByCanonicalAccountId,
} from './InternalIdentityApi.js';
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
  repo?: {
    initialized: boolean;
    rootCid?: string | null;
    rev?: string | null;
  };
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
  repoRegistry?: RepoRegistryBootstrapAdapter;
  logger?: IdentitySyncLogger;
  timeoutMs?: number;
}

export interface RepoRegistryBootstrapState {
  did: string;
  rootCid: string | null;
  rev: string;
  commits: Array<{
    cid: string;
    rootCid: string;
    rev: string;
    timestamp: string;
    signature: string;
    prevCid?: string;
  }>;
  collections: Array<{
    nsid: string;
    recordCount: number;
    rootCid?: string;
    lastUpdated: string;
  }>;
  totalRecords: number;
  sizeBytes: number;
  lastCommitAt: string;
  snapshotAt: string;
}

export interface RepoRegistryBootstrapAdapter {
  getRepoState?(did: string): Promise<RepoRegistryBootstrapState | null>;
  register?(state: RepoRegistryBootstrapState): Promise<void>;
  update?(state: RepoRegistryBootstrapState): Promise<void>;
}

export class HttpIdentityBindingSyncService implements IdentityBindingSyncService {
  private readonly backendBaseUrl: string;
  private readonly bearerToken: string;
  private readonly identityBindingRepository: IdentityBindingRepository;
  private readonly repoRegistry?: RepoRegistryBootstrapAdapter;
  private readonly logger?: IdentitySyncLogger;
  private readonly timeoutMs: number;

  constructor(config: IdentityBindingSyncServiceConfig) {
    this.backendBaseUrl = config.backendBaseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
    this.identityBindingRepository = config.identityBindingRepository;
    this.repoRegistry = config.repoRegistry;
    this.logger = config.logger;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async syncByCanonicalAccountId(canonicalAccountId: string): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'syncByCanonicalAccountId:start', {
      canonicalAccountId,
    });

    return this.fetchAndUpsert(
      buildInternalIdentityProjectionPathsByCanonicalAccountId(canonicalAccountId),
      {
        syncType: 'canonicalAccountId',
        canonicalAccountId,
      }
    );
  }

  async syncByDid(did: string): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'syncByDid:start', { did });
    return this.fetchAndUpsert([buildInternalIdentityProjectionPathByDid(did)], {
      syncType: 'did',
      did,
    });
  }

  async syncByHandle(handle: string): Promise<boolean> {
    traceIdentitySync(this.logger, 'debug', 'syncByHandle:start', { handle });
    return this.fetchAndUpsert([buildInternalIdentityProjectionPathByHandle(handle)], {
      syncType: 'handle',
      handle,
    });
  }

  private async fetchAndUpsert(
    paths: string[],
    meta: Record<string, unknown>
  ): Promise<boolean> {
    for (const path of paths) {
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
        continue;
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

      await this.identityBindingRepository.upsert(backendIdentityProjectionToBinding(payload));

      traceIdentitySync(this.logger, 'info', 'upsert:success', {
        ...meta,
        canonicalAccountId: payload.canonicalAccountId,
        did: payload.atprotoDid,
        handle: payload.atprotoHandle,
      });

      await warmRepoRegistryFromProjection({
        projection: payload,
        repoRegistry: this.repoRegistry,
        logger: this.logger,
        meta,
      });

      return true;
    }

    return false;
  }
}

export function backendIdentityProjectionToBinding(
  payload: BackendIdentityProjection
): IdentityBinding {
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
    apSigningKeyRef:
      payload.atSigningKeyRef || payload.atRotationKeyRef || `${payload.canonicalAccountId}#ap-signing`,
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
    status:
      payload.status === 'active'
        ? 'active'
        : payload.status === 'disabled'
          ? 'suspended'
          : 'suspended',
    createdAt: payload.createdAt ?? now,
    updatedAt: payload.updatedAt ?? now,
  };
}

export function buildRepoRegistryBootstrapState(
  projection: BackendIdentityProjection,
  existing?: RepoRegistryBootstrapState | null
): RepoRegistryBootstrapState | null {
  if (!projection.repo?.initialized || !projection.atprotoDid) {
    return null;
  }

  const now = new Date().toISOString();
  const rootCid = projection.repo.rootCid ?? existing?.rootCid ?? null;
  const rev = projection.repo.rev ?? existing?.rev ?? null;

  if (!rootCid || !rev) {
    return null;
  }

  return {
    did: projection.atprotoDid,
    rootCid,
    rev,
    commits:
      existing?.commits ??
      [
        {
          cid: rootCid,
          rootCid,
          rev,
          timestamp: now,
          signature: '',
        },
      ],
    collections: existing?.collections ?? [],
    totalRecords: existing?.totalRecords ?? 0,
    sizeBytes: existing?.sizeBytes ?? 0,
    lastCommitAt: existing?.lastCommitAt ?? now,
    snapshotAt: now,
  };
}

export async function warmRepoRegistryFromProjection(args: {
  projection: BackendIdentityProjection;
  repoRegistry?: RepoRegistryBootstrapAdapter;
  logger?: IdentitySyncLogger;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { projection, repoRegistry, logger, meta } = args;

  if (!repoRegistry) return;
  if (!projection.repo?.initialized || !projection.atprotoDid) return;

  const existing = repoRegistry.getRepoState
    ? await repoRegistry.getRepoState(projection.atprotoDid)
    : null;
  const nextState = buildRepoRegistryBootstrapState(projection, existing);

  if (!nextState) {
    traceIdentitySync(logger, 'info', 'repo-warm:skipped-incomplete-projection', {
      ...meta,
      did: projection.atprotoDid,
      rootCid: projection.repo.rootCid ?? existing?.rootCid ?? null,
      rev: projection.repo.rev ?? existing?.rev ?? null,
    });
    return;
  }

  if (existing) {
    await repoRegistry.update?.(nextState);
    traceIdentitySync(logger, 'info', 'repo-warm:update-success', {
      ...meta,
      did: nextState.did,
      rootCid: nextState.rootCid,
      rev: nextState.rev,
    });
    return;
  }

  await repoRegistry.register?.(nextState);
  traceIdentitySync(logger, 'info', 'repo-warm:register-success', {
    ...meta,
    did: nextState.did,
    rootCid: nextState.rootCid,
    rev: nextState.rev,
  });
}

export { HttpIdentityBindingSyncService as IdentityBindingSyncServiceImpl };
