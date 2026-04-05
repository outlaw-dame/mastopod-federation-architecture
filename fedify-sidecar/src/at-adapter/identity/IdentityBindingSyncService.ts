import { request } from 'undici';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import { traceIdentitySync, type IdentitySyncLogger } from './IdentitySyncTrace.js';

export interface BackendRepoProjection {
  initialized: boolean;
  rootCid?: string | null;
  rev?: string | null;
}

export interface BackendIdentityProjection {
  canonicalAccountId: string;
  webId: string;
  activityPubActorId?: string | null;
  activityPubHandle?: string | null;
  atprotoDid: string;
  atprotoHandle: string;
  atprotoSource?: 'local' | 'external';
  atprotoManaged?: boolean;
  atprotoPdsUrl?: string | null;
  atSigningKeyRef?: string | null;
  atRotationKeyRef?: string | null;
  status: 'pending' | 'active' | 'disabled';
  repo?: BackendRepoProjection;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackendIdentityChangesResponse {
  items: BackendIdentityProjection[];
  nextCursor: string | null;
}

export interface IdentityBindingSyncService {
  syncByCanonicalAccountId(canonicalAccountId: string): Promise<boolean>;
  syncByDid(did: string): Promise<boolean>;
  syncByHandle(handle: string): Promise<boolean>;
}

export interface RepoRegistryWarmTarget {
  getRepoState?(did: string): Promise<unknown | null>;
  register?(state: unknown): Promise<void>;
}

export interface IdentityBindingSyncServiceConfig {
  backendBaseUrl: string;
  bearerToken: string;
  identityBindingRepository: IdentityBindingRepository;
  repoRegistry?: RepoRegistryWarmTarget;
  logger?: IdentitySyncLogger;
  timeoutMs?: number;
}

interface ApplyIdentityProjectionDeps {
  identityBindingRepository: IdentityBindingRepository;
  repoRegistry?: RepoRegistryWarmTarget;
  logger?: IdentitySyncLogger;
}

export function isBackendIdentityProjection(
  payload: BackendIdentityProjection | null | undefined
): payload is BackendIdentityProjection {
  const isExternal =
    payload?.atprotoSource === 'external' || payload?.atprotoManaged === false;
  const hasLocalKeyRefs = Boolean(payload?.atSigningKeyRef && payload?.atRotationKeyRef);

  return !!(
    payload &&
    payload.canonicalAccountId &&
    payload.webId &&
    payload.atprotoDid &&
    payload.atprotoHandle &&
    payload.status &&
    ((isExternal && payload.atprotoPdsUrl) || hasLocalKeyRefs)
  );
}

export async function applyIdentityProjectionLocally(
  payload: BackendIdentityProjection,
  deps: ApplyIdentityProjectionDeps,
  meta: Record<string, unknown> = {}
): Promise<void> {
  if (!isBackendIdentityProjection(payload)) {
    traceIdentitySync(deps.logger, 'warn', 'projection:invalid-payload', {
      ...meta,
      payload,
    });
    throw new Error('Identity sync received invalid payload');
  }

  await deps.identityBindingRepository.upsert(toIdentityBinding(payload));

  traceIdentitySync(deps.logger, 'info', 'upsert:success', {
    ...meta,
    canonicalAccountId: payload.canonicalAccountId,
    did: payload.atprotoDid,
    handle: payload.atprotoHandle,
  });

  await maybeWarmRepoRegistry(payload, deps.repoRegistry, deps.logger, meta);
}

export class HttpIdentityBindingSyncService implements IdentityBindingSyncService {
  private readonly backendBaseUrl: string;
  private readonly bearerToken: string;
  private readonly identityBindingRepository: IdentityBindingRepository;
  private readonly repoRegistry?: RepoRegistryWarmTarget;
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

  async applyProjection(
    payload: BackendIdentityProjection,
    meta: Record<string, unknown> = {}
  ): Promise<void> {
    await applyIdentityProjectionLocally(
      payload,
      {
        identityBindingRepository: this.identityBindingRepository,
        repoRegistry: this.repoRegistry,
        logger: this.logger,
      },
      meta
    );
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
      repoInitialized: payload.repo?.initialized ?? false,
      atprotoSource: payload.atprotoSource ?? 'local',
      atprotoManaged:
        typeof payload.atprotoManaged === 'boolean' ? payload.atprotoManaged : true,
    });

    await this.applyProjection(payload, meta);

    return true;
  }
}

export { HttpIdentityBindingSyncService as IdentityBindingSyncServiceImpl };

function toIdentityBinding(payload: BackendIdentityProjection): IdentityBinding {
  const now = new Date().toISOString();
  const atprotoSource = payload.atprotoSource ?? 'local';
  const atprotoManaged =
    typeof payload.atprotoManaged === 'boolean'
      ? payload.atprotoManaged
      : atprotoSource !== 'external';

  return {
    canonicalAccountId: payload.canonicalAccountId,
    contextId: 'default',
    webId: payload.webId,
    activityPubActorUri: payload.activityPubActorId ?? payload.webId,
    atprotoDid: payload.atprotoDid,
    atprotoHandle: payload.atprotoHandle,
    canonicalDidMethod: null,
    atprotoPdsEndpoint: payload.atprotoPdsUrl ?? null,
    atprotoSource,
    atprotoManaged,
    apSigningKeyRef:
      payload.atSigningKeyRef ||
      payload.atRotationKeyRef ||
      `${payload.canonicalAccountId}#ap-signing`,
    atSigningKeyRef: payload.atSigningKeyRef ?? null,
    atRotationKeyRef: payload.atRotationKeyRef ?? null,
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
    status: toLocalStatus(payload.status),
    createdAt: payload.createdAt ?? now,
    updatedAt: payload.updatedAt ?? now,
  };
}

function toLocalStatus(status: BackendIdentityProjection['status']): IdentityBinding['status'] {
  if (status === 'active') return 'active';
  if (status === 'disabled') return 'suspended';
  return 'suspended';
}

async function maybeWarmRepoRegistry(
  payload: BackendIdentityProjection,
  repoRegistry: RepoRegistryWarmTarget | undefined,
  logger: IdentitySyncLogger | undefined,
  meta: Record<string, unknown>
): Promise<void> {
  if (!repoRegistry) {
    traceIdentitySync(logger, 'debug', 'repo-warm:skipped-no-registry', meta);
    return;
  }

  if (payload.atprotoSource === 'external' || payload.atprotoManaged === false) {
    traceIdentitySync(logger, 'debug', 'repo-warm:skipped-external-account', {
      ...meta,
      did: payload.atprotoDid,
      pdsUrl: payload.atprotoPdsUrl ?? null,
    });
    return;
  }

  if (!payload.repo?.initialized) {
    traceIdentitySync(logger, 'debug', 'repo-warm:skipped-not-initialized', {
      ...meta,
      did: payload.atprotoDid,
    });
    return;
  }

  if (!payload.repo.rootCid || !payload.repo.rev) {
    traceIdentitySync(logger, 'warn', 'repo-warm:skipped-missing-bootstrap', {
      ...meta,
      did: payload.atprotoDid,
    });
    return;
  }

  const existing = typeof repoRegistry.getRepoState === 'function'
    ? await repoRegistry.getRepoState(payload.atprotoDid)
    : null;

  if (existing) {
    traceIdentitySync(logger, 'debug', 'repo-warm:skipped-existing', {
      ...meta,
      did: payload.atprotoDid,
    });
    return;
  }

  if (typeof repoRegistry.register !== 'function') {
    traceIdentitySync(logger, 'warn', 'repo-warm:skipped-no-register', {
      ...meta,
      did: payload.atprotoDid,
    });
    return;
  }

  const state = buildBootstrapRepoState(payload.atprotoDid, payload.repo.rootCid, payload.repo.rev);

  try {
    await repoRegistry.register(state);
    traceIdentitySync(logger, 'info', 'repo-warm:register-success', {
      ...meta,
      did: payload.atprotoDid,
      rootCid: payload.repo.rootCid,
      rev: payload.repo.rev,
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      traceIdentitySync(logger, 'debug', 'repo-warm:already-exists', {
        ...meta,
        did: payload.atprotoDid,
      });
      return;
    }

    traceIdentitySync(logger, 'warn', 'repo-warm:register-failed', {
      ...meta,
      did: payload.atprotoDid,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function buildBootstrapRepoState(did: string, rootCid: string, rev: string) {
  const now = new Date().toISOString();

  return {
    did,
    rootCid,
    rev,
    commits: [
      {
        cid: rootCid,
        rootCid,
        rev,
        timestamp: now,
        signature: '',
      },
    ],
    collections: [],
    totalRecords: 0,
    sizeBytes: 0,
    lastCommitAt: now,
    snapshotAt: now,
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === 'ALREADY_EXISTS' ||
    String(candidate.message ?? '').includes('already exists')
  );
}
