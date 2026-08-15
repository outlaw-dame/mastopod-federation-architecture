import { describe, expect, it, vi } from 'vitest';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { BackendIdentityChangesResponse, BackendIdentityProjection } from './IdentityBindingSyncService.js';
import {
  IdentityWarmupService,
  type IdentityWarmCursorStore,
  type IdentityWarmReplayState,
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

type TestCursorStore = IdentityWarmCursorStore & {
  current: string | null;
  replay: IdentityWarmReplayState | null;
};

function makeCursorStore(initial: string | null): TestCursorStore {
  return {
    current: initial,
    replay: null,
    async getCursor() {
      return this.current;
    },
    async setCursor(value: string) {
      this.current = value;
    },
    async getReplayState() {
      return this.replay;
    },
    async setReplayState(value: IdentityWarmReplayState) {
      this.replay = { ...value };
    },
    async clearReplayState() {
      this.replay = null;
    },
  };
}

function makeRepository() {
  return {
    upsert: vi.fn(async () => undefined),
  } as unknown as IdentityBindingRepository;
}

type MutableWarmup = {
  fetchChangesWithRetry(since: string | null): Promise<BackendIdentityChangesResponse>;
};

describe('IdentityWarmupService forward progress', () => {
  it('advances from the durable cursor before replaying a dense overlap window', async () => {
    const stored = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/c/profile/card#me');
    const forward = cursor('2026-08-14T20:00:02.000Z', 'https://pod.example/e/profile/card#me');
    const store = makeCursorStore(stored);
    const repository = makeRepository();
    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: repository,
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
    });

    const requested: Array<string | null> = [];
    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      if (since === stored) {
        return {
          items: [
            projection('d', '2026-08-14T20:00:01.000Z'),
            projection('e', '2026-08-14T20:00:02.000Z'),
          ],
          nextCursor: forward,
        };
      }
      throw new Error(`unexpected cursor: ${String(since)}`);
    });

    const result = await service.pollOnce();

    expect(requested).toEqual([stored]);
    expect(store.current).toBe(forward);
    expect(store.replay).toBeNull();
    expect(result.nextCursor).toBe(forward);
    expect(result.items).toBe(2);
    expect(repository.upsert).toHaveBeenCalledTimes(2);
  });

  it('drains overlap pages independently once forward catch-up is unsaturated', async () => {
    const highWater = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const replayPage1 = cursor('2026-08-14T19:59:20.000Z', 'https://pod.example/b/profile/card#me');
    const replayPage2 = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const store = makeCursorStore(highWater);
    const repository = makeRepository();
    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: repository,
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
    });

    const requested: Array<string | null> = [];
    let replayCalls = 0;
    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      if (since === highWater) return { items: [], nextCursor: highWater };

      replayCalls += 1;
      if (replayCalls === 1) {
        return {
          items: [
            projection('a', '2026-08-14T19:59:10.000Z'),
            projection('b', '2026-08-14T19:59:20.000Z'),
          ],
          nextCursor: replayPage1,
        };
      }
      if (replayCalls === 2) {
        return {
          items: [projection('z', '2026-08-14T20:00:00.000Z')],
          nextCursor: replayPage2,
        };
      }
      throw new Error('unexpected extra replay page');
    });

    const first = await service.pollOnce();
    expect(store.replay?.cursor).toBe(replayPage1);
    const second = await service.pollOnce();

    expect(requested[0]).toBe(highWater);
    expect(requested[2]).toBe(highWater);
    expect(requested[3]).toBe(replayPage1);
    expect(requested[1]).not.toBe(highWater);
    expect(requested[1]).not.toBe(replayPage1);
    expect(first.nextCursor).toBe(highWater);
    expect(second.nextCursor).toBe(highWater);
    expect(store.current).toBe(highWater);
    expect(store.replay).toBeNull();
    expect(repository.upsert).toHaveBeenCalledTimes(3);
  });

  it('resumes persisted replay state after restart instead of rewinding from a newer high-water mark', async () => {
    const originalTarget = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const persistedReplay = cursor('2026-08-14T19:59:20.000Z', 'https://pod.example/b/profile/card#me');
    const newerHighWater = cursor('2026-08-14T20:01:00.000Z', 'https://pod.example/new/profile/card#me');
    const replayDone = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const store = makeCursorStore(newerHighWater);
    store.replay = { cursor: persistedReplay, targetCursor: originalTarget };

    const serviceAfterRestart = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
    });

    const requested: Array<string | null> = [];
    (serviceAfterRestart as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      if (since === newerHighWater) return { items: [], nextCursor: newerHighWater };
      if (since === persistedReplay) {
        return {
          items: [projection('z', '2026-08-14T20:00:00.000Z')],
          nextCursor: replayDone,
        };
      }
      throw new Error(`unexpected cursor ${String(since)}`);
    });

    await serviceAfterRestart.pollOnce();

    expect(requested).toEqual([newerHighWater, persistedReplay]);
    expect(store.current).toBe(newerHighWater);
    expect(store.replay).toBeNull();
  });

  it('pauses an active replay cycle whenever the forward page is saturated', async () => {
    const highWater = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const forward = cursor('2026-08-14T20:00:02.000Z', 'https://pod.example/b/profile/card#me');
    const replayCursor = cursor('2026-08-14T19:59:20.000Z', 'https://pod.example/replay/profile/card#me');
    const store = makeCursorStore(highWater);
    store.replay = { cursor: replayCursor, targetCursor: highWater };

    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
    });

    const requested: Array<string | null> = [];
    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      if (since !== highWater) throw new Error('replay should be paused');
      return {
        items: [
          projection('a', '2026-08-14T20:00:01.000Z'),
          projection('b', '2026-08-14T20:00:02.000Z'),
        ],
        nextCursor: forward,
      };
    });

    const result = await service.pollOnce();

    expect(requested).toEqual([highWater]);
    expect(result.items).toBe(2);
    expect(store.current).toBe(forward);
    expect(store.replay).toEqual({ cursor: replayCursor, targetCursor: highWater });
  });

  it('never lets overlap replay regress the durable high-water mark', async () => {
    const highWater = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const older = cursor('2026-08-14T19:59:30.000Z', 'https://pod.example/m/profile/card#me');
    const store = makeCursorStore(highWater);
    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
    });

    let calls = 0;
    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { items: [], nextCursor: highWater };
      return {
        items: [projection('m', '2026-08-14T19:59:30.000Z')],
        nextCursor: older,
      };
    });

    const result = await service.pollOnce();

    expect(result.nextCursor).toBe(highWater);
    expect(store.current).toBe(highWater);
  });
});
