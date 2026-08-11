import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAtAccountResolver } from '../auth/DefaultAtAccountResolver.js';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { IdentityBindingSyncService } from '../identity/IdentityBindingSyncService.js';

interface TestBinding {
  canonicalAccountId: string;
  webId: string;
  atprotoDid: string | null;
  atprotoHandle: string | null;
  atprotoPdsEndpoint?: string | null;
  atprotoManaged?: boolean;
  atprotoSource?: 'local' | 'external';
  status: 'active' | 'suspended' | 'deactivated' | 'pending';
}

const LOCAL_BINDING: TestBinding = {
  canonicalAccountId: 'https://pods.test/alice',
  webId: 'https://pods.test/alice',
  atprotoDid: 'did:plc:alice00000000000000000000',
  atprotoHandle: 'alice.pods.test',
  atprotoManaged: true,
  atprotoSource: 'local',
  atprotoPdsEndpoint: null,
  status: 'active',
};

function createRepo() {
  return {
    getByAtprotoDid: vi.fn(),
    getByAtprotoHandle: vi.fn(),
    getByCanonicalAccountId: vi.fn(),
  } as unknown as IdentityBindingRepository & {
    getByAtprotoDid: ReturnType<typeof vi.fn>;
    getByAtprotoHandle: ReturnType<typeof vi.fn>;
    getByCanonicalAccountId: ReturnType<typeof vi.fn>;
  };
}

function createSyncService() {
  return {
    syncByDid: vi.fn().mockResolvedValue(false),
    syncByHandle: vi.fn().mockResolvedValue(false),
    syncByCanonicalAccountId: vi.fn().mockResolvedValue(false),
  } as unknown as IdentityBindingSyncService & {
    syncByDid: ReturnType<typeof vi.fn>;
    syncByHandle: ReturnType<typeof vi.fn>;
    syncByCanonicalAccountId: ReturnType<typeof vi.fn>;
  };
}

describe('DefaultAtAccountResolver sync-on-miss', () => {
  let repo: ReturnType<typeof createRepo>;
  let sync: ReturnType<typeof createSyncService>;

  beforeEach(() => {
    repo = createRepo();
    sync = createSyncService();
  });

  it('returns an active local handle hit without invoking backend sync', async () => {
    repo.getByAtprotoHandle.mockResolvedValue(LOCAL_BINDING);
    const resolver = new DefaultAtAccountResolver(repo, sync);

    const resolved = await resolver.resolveByIdentifier('alice.pods.test');

    expect(resolved).toMatchObject({
      canonicalAccountId: LOCAL_BINDING.canonicalAccountId,
      did: LOCAL_BINDING.atprotoDid,
      handle: LOCAL_BINDING.atprotoHandle,
      atprotoManaged: true,
      atprotoSource: 'local',
    });
    expect(sync.syncByHandle).not.toHaveBeenCalled();
  });

  it('syncs a missing DID once and re-reads the local repository', async () => {
    repo.getByAtprotoDid
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(LOCAL_BINDING);
    sync.syncByDid.mockResolvedValue(true);
    const resolver = new DefaultAtAccountResolver(repo, sync);

    const resolved = await resolver.resolveByIdentifier(LOCAL_BINDING.atprotoDid!);

    expect(sync.syncByDid).toHaveBeenCalledTimes(1);
    expect(sync.syncByDid).toHaveBeenCalledWith(LOCAL_BINDING.atprotoDid);
    expect(repo.getByAtprotoDid).toHaveBeenCalledTimes(2);
    expect(resolved?.handle).toBe(LOCAL_BINDING.atprotoHandle);
  });

  it('syncs a missing handle once and re-reads the local repository', async () => {
    repo.getByAtprotoHandle
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(LOCAL_BINDING);
    sync.syncByHandle.mockResolvedValue(true);
    const resolver = new DefaultAtAccountResolver(repo, sync);

    const resolved = await resolver.resolveByIdentifier('alice.pods.test');

    expect(sync.syncByHandle).toHaveBeenCalledTimes(1);
    expect(sync.syncByHandle).toHaveBeenCalledWith('alice.pods.test');
    expect(repo.getByAtprotoHandle).toHaveBeenCalledTimes(2);
    expect(resolved?.did).toBe(LOCAL_BINDING.atprotoDid);
  });

  it('syncs a missing canonical account URL through the canonical projection endpoint', async () => {
    repo.getByCanonicalAccountId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(LOCAL_BINDING);
    sync.syncByCanonicalAccountId.mockResolvedValue(true);
    const resolver = new DefaultAtAccountResolver(repo, sync);

    const resolved = await resolver.resolveByIdentifier(LOCAL_BINDING.canonicalAccountId);

    expect(sync.syncByCanonicalAccountId).toHaveBeenCalledWith(LOCAL_BINDING.canonicalAccountId);
    expect(repo.getByCanonicalAccountId).toHaveBeenCalledTimes(2);
    expect(resolved?.did).toBe(LOCAL_BINDING.atprotoDid);
  });

  it('returns null after a backend miss instead of performing repeated sync attempts', async () => {
    repo.getByAtprotoHandle.mockResolvedValue(null);
    sync.syncByHandle.mockResolvedValue(false);
    const resolver = new DefaultAtAccountResolver(repo, sync);

    expect(await resolver.resolveByIdentifier('missing.pods.test')).toBeNull();
    expect(sync.syncByHandle).toHaveBeenCalledTimes(1);
    expect(repo.getByAtprotoHandle).toHaveBeenCalledTimes(1);
  });

  it.each(['suspended', 'deactivated', 'pending'] as const)(
    'rejects a %s account even when the binding is present',
    async status => {
      repo.getByAtprotoDid.mockResolvedValue({ ...LOCAL_BINDING, status });
      const resolver = new DefaultAtAccountResolver(repo, sync);

      expect(await resolver.resolveByIdentifier(LOCAL_BINDING.atprotoDid!)).toBeNull();
      expect(sync.syncByDid).not.toHaveBeenCalled();
    },
  );

  it('rejects an incomplete active binding with no AT DID or handle', async () => {
    repo.getByAtprotoHandle.mockResolvedValue({
      ...LOCAL_BINDING,
      atprotoDid: null,
      atprotoHandle: null,
    });
    const resolver = new DefaultAtAccountResolver(repo, sync);

    expect(await resolver.resolveByIdentifier('alice.pods.test')).toBeNull();
  });

  it('accepts an external PDS binding only when its PDS endpoint is present', async () => {
    const external = {
      ...LOCAL_BINDING,
      atprotoManaged: false,
      atprotoSource: 'external' as const,
      atprotoPdsEndpoint: 'https://pds.example',
    };
    repo.getByAtprotoDid.mockResolvedValue(external);
    const resolver = new DefaultAtAccountResolver(repo, sync);

    expect(await resolver.resolveByIdentifier(external.atprotoDid!)).toMatchObject({
      atprotoManaged: false,
      atprotoSource: 'external',
      atprotoPdsUrl: 'https://pds.example',
    });
  });

  it('fails closed for an external PDS binding with no PDS endpoint', async () => {
    repo.getByAtprotoDid.mockResolvedValue({
      ...LOCAL_BINDING,
      atprotoManaged: false,
      atprotoSource: 'external',
      atprotoPdsEndpoint: null,
    });
    const resolver = new DefaultAtAccountResolver(repo, sync);

    expect(await resolver.resolveByIdentifier(LOCAL_BINDING.atprotoDid!)).toBeNull();
  });

  it('returns null for blank identifiers without touching storage or sync', async () => {
    const resolver = new DefaultAtAccountResolver(repo, sync);

    expect(await resolver.resolveByIdentifier('   ')).toBeNull();
    expect(repo.getByAtprotoDid).not.toHaveBeenCalled();
    expect(repo.getByAtprotoHandle).not.toHaveBeenCalled();
    expect(repo.getByCanonicalAccountId).not.toHaveBeenCalled();
    expect(sync.syncByDid).not.toHaveBeenCalled();
    expect(sync.syncByHandle).not.toHaveBeenCalled();
    expect(sync.syncByCanonicalAccountId).not.toHaveBeenCalled();
  });
});
