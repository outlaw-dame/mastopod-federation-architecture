import { describe, expect, it, vi } from 'vitest';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { BackendIdentityChangesResponse, BackendIdentityProjection } from './IdentityBindingSyncService.js';
import {
  IdentityWarmupService,
  type IdentityWarmReplayState,
  type IdentityWarmCursorStore,
} from './IdentityWarmupService.js';

function cursor(updatedAt: string, canonicalAccountId: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, canonicalAccountId }), 'utf8').toString('base64url');
}

function projection(name: string, updatedAt: string): BackendIdentityProjection {
  return {
    canonicalAccountId: `https://pod.example/${name}/profile/card#me`,
    webId: `https://pod.example/${name}/profile/card#me`,
    activityPubActorId: `https://pod.example/${name}`,
    activityPubHandle: `@${name}@pod.example`,
    atprotoDid: `did:plc:${name}`,
    atprotoHandle: `${name}.pod.example`,
    atprotoSource: 'local',
    atprotoManaged: true,
    atSigningKeyRef: `key:${name}:signing`,
    atRotationKeyRef: `key:${name}:rotation`,
    status: 'active',
    updatedAt,
  };
}

type MutableWarmup = {
  fetchChangesWithRetry(since: string | null): Promise<BackendIdentityChangesResponse>;
};

describe('IdentityWarmupService crash ordering', () => {
  it('persists a new replay obligation before a fallback store advances the cursor', async () => {
    const stored = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/a/profile/card#me');
    const forward = cursor('2026-08-14T20:00:01.000Z', 'https://pod.example/b/profile/card#me');
    let replayState: IdentityWarmReplayState | null = null;
    const calls: string[] = [];

    const cursorStore: IdentityWarmCursorStore = {
      async getCursor() {
        return stored;
      },
      async setCursor() {
        calls.push('cursor');
        throw new Error('simulated cursor persistence failure');
      },
      async getReplayState() {
        return replayState;
      },
      async setReplayState(state) {
        calls.push('replay');
        replayState = state;
      },
      async clearReplayState() {
        replayState = null;
      },
    };

    const repository = {
      upsert: vi.fn(async () => undefined),
    } as unknown as IdentityBindingRepository;
    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: repository,
      cursorStore,
      batchLimit: 2,
      replayOverlapMs: 60_000,
    });

    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      expect(since).toBe(stored);
      return {
        items: [projection('b', '2026-08-14T20:00:01.000Z')],
        nextCursor: forward,
      };
    });

    await expect(service.pollOnce()).rejects.toThrow('simulated cursor persistence failure');

    expect(calls).toEqual(['replay', 'cursor']);
    expect(replayState).not.toBeNull();
    expect(replayState?.targetCursor).toBe(forward);
    expect(repository.upsert).toHaveBeenCalledTimes(1);
  });
});
