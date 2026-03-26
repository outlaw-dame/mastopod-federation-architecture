/**
 * Option 2 Identity Propagation — Unit Tests
 *
 * Covers the pull-on-miss mechanism:
 *   1. DefaultAtAccountResolver falls through to the sync service when a DID
 *      or handle is absent from the local Redis store.
 *   2. HttpIdentityBindingSyncService fetches from the backend internal API
 *      and upserts the result into the identity binding repository.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DefaultAtAccountResolver } from '../auth/DefaultAtAccountResolver.js';
import type { IdentityBindingSyncService } from '../identity/IdentityBindingSyncService.js';
import {
  HttpIdentityBindingSyncService,
  type BackendIdentityProjection,
  type HttpRequestFn,
} from '../identity/IdentityBindingSyncService.js';
import type { IdentityBinding } from '../../core-domain/identity/IdentityBinding.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';

// ---------------------------------------------------------------------------
// Minimal in-memory identity binding repository
// ---------------------------------------------------------------------------

class InMemoryIdentityBindingRepository implements IdentityBindingRepository {
  private readonly store = new Map<string, IdentityBinding>();
  private readonly byDid = new Map<string, string>();
  private readonly byHandle = new Map<string, string>();
  private readonly byActor = new Map<string, string>();
  private readonly byWebId = new Map<string, string>();

  async getByCanonicalAccountId(id: string): Promise<IdentityBinding | null> {
    return this.store.get(id) ?? null;
  }
  async getByAtprotoDid(did: string): Promise<IdentityBinding | null> {
    const id = this.byDid.get(did);
    return id ? (this.store.get(id) ?? null) : null;
  }
  async getByAtprotoHandle(handle: string): Promise<IdentityBinding | null> {
    const id = this.byHandle.get(handle.toLowerCase());
    return id ? (this.store.get(id) ?? null) : null;
  }
  async findByHandle(handle: string): Promise<IdentityBinding | null> {
    return this.getByAtprotoHandle(handle);
  }
  async getByActivityPubActorUri(uri: string): Promise<IdentityBinding | null> {
    const id = this.byActor.get(uri);
    return id ? (this.store.get(id) ?? null) : null;
  }
  async getByWebId(webId: string): Promise<IdentityBinding | null> {
    const id = this.byWebId.get(webId);
    return id ? (this.store.get(id) ?? null) : null;
  }
  async getByContextAndUsername(_ctx: string, _user: string): Promise<IdentityBinding | null> {
    return null;
  }
  async create(b: IdentityBinding): Promise<void> { this.write(b); }
  async update(b: IdentityBinding): Promise<void> { this.write(b); }
  async upsert(b: IdentityBinding): Promise<void> { this.write(b); }
  async delete(id: string): Promise<boolean> { return this.store.delete(id); }
  async listByContext(_ctx: string, limit = 100, offset = 0): Promise<IdentityBinding[]> {
    return [...this.store.values()].slice(offset, offset + limit);
  }
  async listByStatus(status: IdentityBinding['status'], limit = 100, offset = 0): Promise<IdentityBinding[]> {
    return [...this.store.values()].filter((b) => b.status === status).slice(offset, offset + limit);
  }
  async listWithPendingPlcUpdates(): Promise<IdentityBinding[]> { return []; }
  async countByContext(): Promise<number> { return this.store.size; }
  async exists(id: string): Promise<boolean> { return this.store.has(id); }
  async didExists(did: string): Promise<boolean> { return this.byDid.has(did); }
  async handleExists(handle: string): Promise<boolean> { return this.byHandle.has(handle.toLowerCase()); }
  async actorUriExists(uri: string): Promise<boolean> { return this.byActor.has(uri); }
  async getBatch(ids: string[]): Promise<Map<string, IdentityBinding>> {
    const result = new Map<string, IdentityBinding>();
    for (const id of ids) {
      const b = this.store.get(id);
      if (b) result.set(id, b);
    }
    return result;
  }
  async transaction<T>(cb: (repo: IdentityBindingRepository) => Promise<T>): Promise<T> {
    return cb(this);
  }
  async health(): Promise<boolean> { return true; }

  private write(b: IdentityBinding): void {
    this.store.set(b.canonicalAccountId, b);
    if (b.atprotoDid) this.byDid.set(b.atprotoDid, b.canonicalAccountId);
    if (b.atprotoHandle) this.byHandle.set(b.atprotoHandle.toLowerCase(), b.canonicalAccountId);
    if (b.activityPubActorUri) this.byActor.set(b.activityPubActorUri, b.canonicalAccountId);
    if (b.webId) this.byWebId.set(b.webId, b.canonicalAccountId);
  }
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

function makeBinding(overrides: Partial<IdentityBinding> = {}): IdentityBinding {
  return {
    canonicalAccountId: 'https://pods.test/users/alice',
    contextId: 'pods.test',
    webId: 'https://pods.test/users/alice',
    activityPubActorUri: 'https://pods.test/users/alice',
    atprotoDid: 'did:plc:synctest000001',
    atprotoHandle: 'alice.pods.test',
    canonicalDidMethod: 'did:plc',
    atprotoPdsEndpoint: null,
    apSigningKeyRef: 'https://pods.test/keys/ap-signing',
    atSigningKeyRef: 'https://pods.test/keys/at-signing',
    atRotationKeyRef: 'https://pods.test/keys/at-rotation',
    plc: {
      opCid: null,
      rotationKeyRef: 'https://pods.test/keys/at-rotation',
      plcUpdateState: null,
      lastSubmittedAt: null,
      lastConfirmedAt: null,
      lastError: null,
    },
    didWeb: null,
    accountLinks: { apAlsoKnownAs: [], atAlsoKnownAs: [], relMe: [], webIdSameAs: [], webIdAccounts: [] },
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeBackendProjection(overrides: Partial<BackendIdentityProjection> = {}): BackendIdentityProjection {
  return {
    canonicalAccountId: 'https://pods.test/users/alice',
    webId: 'https://pods.test/users/alice',
    atprotoDid: 'did:plc:synctest000001',
    atprotoHandle: 'alice.pods.test',
    atSigningKeyRef: 'https://pods.test/keys/at-signing',
    atRotationKeyRef: 'https://pods.test/keys/at-rotation',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DefaultAtAccountResolver — pull-on-miss tests
// ---------------------------------------------------------------------------

describe('DefaultAtAccountResolver — pull-on-miss', () => {
  let identityRepo: InMemoryIdentityBindingRepository;
  let syncService: IdentityBindingSyncService;

  beforeEach(() => {
    identityRepo = new InMemoryIdentityBindingRepository();
    syncService = {
      syncByDid: vi.fn().mockResolvedValue(false),
      syncByHandle: vi.fn().mockResolvedValue(false),
      syncByCanonicalAccountId: vi.fn().mockResolvedValue(false),
    };
  });

  it('returns account from local repo without calling sync when found locally by handle', async () => {
    await identityRepo.upsert(makeBinding());
    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);

    const result = await resolver.resolveByIdentifier('alice.pods.test');

    expect(result).not.toBeNull();
    expect(result!.did).toBe('did:plc:synctest000001');
    expect(syncService.syncByHandle).not.toHaveBeenCalled();
  });

  it('returns account from local repo without calling sync when found locally by DID', async () => {
    await identityRepo.upsert(makeBinding());
    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);

    const result = await resolver.resolveByIdentifier('did:plc:synctest000001');

    expect(result).not.toBeNull();
    expect(result!.handle).toBe('alice.pods.test');
    expect(syncService.syncByDid).not.toHaveBeenCalled();
  });

  it('calls syncByHandle and re-resolves when handle is absent from local repo', async () => {
    // Sync service will inject the binding into the repo on call
    vi.mocked(syncService.syncByHandle).mockImplementation(async () => {
      await identityRepo.upsert(makeBinding());
      return true;
    });

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    const result = await resolver.resolveByIdentifier('alice.pods.test');

    expect(syncService.syncByHandle).toHaveBeenCalledWith('alice.pods.test');
    expect(result).not.toBeNull();
    expect(result!.did).toBe('did:plc:synctest000001');
    expect(result!.canonicalAccountId).toBe('https://pods.test/users/alice');
  });

  it('calls syncByDid and re-resolves when DID is absent from local repo', async () => {
    vi.mocked(syncService.syncByDid).mockImplementation(async () => {
      await identityRepo.upsert(makeBinding());
      return true;
    });

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    const result = await resolver.resolveByIdentifier('did:plc:synctest000001');

    expect(syncService.syncByDid).toHaveBeenCalledWith('did:plc:synctest000001');
    expect(result).not.toBeNull();
    expect(result!.handle).toBe('alice.pods.test');
  });

  it('calls syncByCanonicalAccountId and re-resolves when canonical URL is absent', async () => {
    vi.mocked(syncService.syncByCanonicalAccountId).mockImplementation(async () => {
      await identityRepo.upsert(makeBinding());
      return true;
    });

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    const result = await resolver.resolveByIdentifier('https://pods.test/users/alice');

    expect(syncService.syncByCanonicalAccountId).toHaveBeenCalledWith('https://pods.test/users/alice');
    expect(result).not.toBeNull();
  });

  it('returns null when sync reports no account found', async () => {
    vi.mocked(syncService.syncByHandle).mockResolvedValue(false);

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    const result = await resolver.resolveByIdentifier('unknown.pods.test');

    expect(result).toBeNull();
  });

  it('returns null when sync succeeds but account is suspended', async () => {
    vi.mocked(syncService.syncByDid).mockImplementation(async () => {
      await identityRepo.upsert(makeBinding({ status: 'suspended' }));
      return true;
    });

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    const result = await resolver.resolveByIdentifier('did:plc:synctest000001');

    expect(result).toBeNull();
  });

  it('returns null when sync succeeds but atprotoDid is missing', async () => {
    vi.mocked(syncService.syncByHandle).mockImplementation(async () => {
      await identityRepo.upsert(makeBinding({ atprotoDid: '' }));
      return true;
    });

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    const result = await resolver.resolveByIdentifier('alice.pods.test');

    expect(result).toBeNull();
  });

  it('works without a sync service (returns null on local miss)', async () => {
    const resolver = new DefaultAtAccountResolver(identityRepo); // no sync service

    const result = await resolver.resolveByIdentifier('alice.pods.test');

    expect(result).toBeNull();
  });

  it('returns null for an empty identifier', async () => {
    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);
    expect(await resolver.resolveByIdentifier('')).toBeNull();
    expect(await resolver.resolveByIdentifier('  ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HttpIdentityBindingSyncService — backend fetch and upsert tests
// ---------------------------------------------------------------------------

describe('HttpIdentityBindingSyncService', () => {
  let identityRepo: InMemoryIdentityBindingRepository;
  // vi.fn() infers the mock type from the HttpRequestFn type parameter at call sites
  let mockRequestFn: ReturnType<typeof vi.fn>;

  function makeSyncService(): HttpIdentityBindingSyncService {
    return new HttpIdentityBindingSyncService({
      backendBaseUrl: 'http://backend.test',
      bearerToken: 'test-token',
      identityBindingRepository: identityRepo,
      timeoutMs: 5_000,
      requestFn: mockRequestFn as HttpRequestFn,
    });
  }

  beforeEach(() => {
    identityRepo = new InMemoryIdentityBindingRepository();
    mockRequestFn = vi.fn();
  });

  /**
   * Build a minimal response object that mirrors the subset of undici's
   * response type used by HttpIdentityBindingSyncService.fetchAndUpsert().
   */
  function mockResponse(statusCode: number, body: unknown) {
    return {
      statusCode,
      body: {
        json: vi.fn().mockResolvedValue(body),
        text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      },
    };
  }

  it('fetches by DID and upserts the binding into the repo', async () => {
    const projection = makeBackendProjection();
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    const result = await svc.syncByDid('did:plc:synctest000001');

    expect(result).toBe(true);

    const stored = await identityRepo.getByAtprotoDid('did:plc:synctest000001');
    expect(stored).not.toBeNull();
    expect(stored!.atprotoHandle).toBe('alice.pods.test');
    expect(stored!.status).toBe('active');
  });

  it('fetches by handle and upserts the binding into the repo', async () => {
    const projection = makeBackendProjection();
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    const result = await svc.syncByHandle('Alice.Pods.Test'); // mixed case normalised to lower

    expect(result).toBe(true);

    const stored = await identityRepo.getByAtprotoHandle('alice.pods.test');
    expect(stored).not.toBeNull();
    expect(stored!.atprotoDid).toBe('did:plc:synctest000001');
  });

  it('normalises handle to lower-case before sending to backend and indexing', async () => {
    const projection = makeBackendProjection();
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    await svc.syncByHandle('ALICE.PODS.TEST');

    // The URL sent to the backend should contain the lower-cased handle
    const calledUrl = (mockRequestFn.mock.calls[0]?.[0] as string) ?? '';
    expect(calledUrl).toContain(encodeURIComponent('alice.pods.test'));

    // Lookup by mixed/upper case should resolve via the lower-cased index
    const storedByLower = await identityRepo.getByAtprotoHandle('alice.pods.test');
    expect(storedByLower).not.toBeNull();
    const storedByUpper = await identityRepo.getByAtprotoHandle('ALICE.PODS.TEST');
    expect(storedByUpper).not.toBeNull();
  });

  it('fetches by canonical account ID and upserts the binding', async () => {
    const projection = makeBackendProjection();
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    const result = await svc.syncByCanonicalAccountId('https://pods.test/users/alice');

    expect(result).toBe(true);

    const stored = await identityRepo.getByCanonicalAccountId('https://pods.test/users/alice');
    expect(stored).not.toBeNull();
  });

  it('returns false (no error) when backend returns 404', async () => {
    mockRequestFn.mockResolvedValue(mockResponse(404, null));

    const svc = makeSyncService();
    const result = await svc.syncByDid('did:plc:nobody');

    expect(result).toBe(false);
    expect(await identityRepo.getByAtprotoDid('did:plc:nobody')).toBeNull();
  });

  it('maps backend "disabled" status to local "suspended"', async () => {
    const projection = makeBackendProjection({ status: 'disabled' });
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    await svc.syncByDid('did:plc:synctest000001');

    const stored = await identityRepo.getByAtprotoDid('did:plc:synctest000001');
    expect(stored!.status).toBe('suspended');
  });

  it('maps backend "pending" status to local "suspended"', async () => {
    const projection = makeBackendProjection({ status: 'pending' });
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    await svc.syncByDid('did:plc:synctest000001');

    const stored = await identityRepo.getByAtprotoDid('did:plc:synctest000001');
    expect(stored!.status).toBe('suspended');
  });

  it('falls back to atSigningKeyRef for apSigningKeyRef when activityPubActorId is absent', async () => {
    const projection = makeBackendProjection({
      activityPubActorId: undefined,
    });
    mockRequestFn.mockResolvedValue(mockResponse(200, projection));

    const svc = makeSyncService();
    await svc.syncByDid('did:plc:synctest000001');

    const stored = await identityRepo.getByAtprotoDid('did:plc:synctest000001');
    // activityPubActorUri should fall back to webId
    expect(stored!.activityPubActorUri).toBe(projection.webId);
  });
});

// ---------------------------------------------------------------------------
// Integration: resolver + sync service end-to-end pull-on-miss
// ---------------------------------------------------------------------------

describe('DefaultAtAccountResolver + HttpIdentityBindingSyncService — integration', () => {
  it('createSession flow: resolves an unknown account by DID via backend sync', async () => {
    const identityRepo = new InMemoryIdentityBindingRepository();
    let upsertWasCalled = false;

    // Lightweight stub for sync service — bypasses HTTP, writes directly
    const syncService: IdentityBindingSyncService = {
      syncByDid: async (did) => {
        if (did !== 'did:plc:synctest000001') return false;
        await identityRepo.upsert(makeBinding());
        upsertWasCalled = true;
        return true;
      },
      syncByHandle: vi.fn().mockResolvedValue(false),
      syncByCanonicalAccountId: vi.fn().mockResolvedValue(false),
    };

    const resolver = new DefaultAtAccountResolver(identityRepo, syncService);

    // Simulate first-time login with a DID that isn't yet in Redis
    const account = await resolver.resolveByIdentifier('did:plc:synctest000001');

    expect(upsertWasCalled).toBe(true);
    expect(account).not.toBeNull();
    expect(account!.did).toBe('did:plc:synctest000001');
    expect(account!.handle).toBe('alice.pods.test');
    expect(account!.canonicalAccountId).toBe('https://pods.test/users/alice');
  });
});
