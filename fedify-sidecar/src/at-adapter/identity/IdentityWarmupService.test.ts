import { describe, expect, it, vi } from 'vitest';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type { BackendIdentityChangesResponse, BackendIdentityProjection } from './IdentityBindingSyncService.js';
import {
  IdentityWarmupService,
  type IdentityWarmCursorStore,
  type IdentityWarmReplayState,
} from './IdentityWarmupService.js';

const NOW_MS = 1_800_000_000_000;

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
  it('advances from the durable cursor while creating replay coverage for a saturated page', async () => {
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
      now: () => NOW_MS,
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
    expect(store.replay?.targetCursor).toBe(forward);
    expect(store.replay?.baseCursor).toBe(store.replay?.cursor);
    expect(store.replay?.settleUntilMs).toBe(NOW_MS + 60_000);
    expect(result.nextCursor).toBe(forward);
    expect(result.items).toBe(2);
    expect(repository.upsert).toHaveBeenCalledTimes(2);
  });

  it('drains one replay page per caught-up poll and resets to the durable base before the horizon closes', async () => {
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
      now: () => NOW_MS,
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
    const base = store.replay?.baseCursor ?? null;
    expect(store.replay?.cursor).toBe(replayPage1);
    const second = await service.pollOnce();

    expect(requested[0]).toBe(highWater);
    expect(requested[2]).toBe(highWater);
    expect(requested[3]).toBe(replayPage1);
    expect(first.nextCursor).toBe(highWater);
    expect(second.nextCursor).toBe(highWater);
    expect(store.current).toBe(highWater);
    expect(store.replay?.cursor).toBe(base);
    expect(store.replay?.baseCursor).toBe(base);
    expect(store.replay?.targetCursor).toBe(highWater);
    expect(repository.upsert).toHaveBeenCalledTimes(3);
  });

  it('resumes a persisted replay after restart without reconstructing it from the high-water mark', async () => {
    const target = cursor('2026-08-14T20:01:00.000Z', 'https://pod.example/new/profile/card#me');
    const persistedReplay = cursor('2026-08-14T19:59:20.000Z', 'https://pod.example/b/profile/card#me');
    const store = makeCursorStore(target);
    store.replay = {
      cursor: persistedReplay,
      baseCursor: persistedReplay,
      targetCursor: target,
      settleUntilMs: NOW_MS - 1,
    };

    const serviceAfterRestart = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
      now: () => NOW_MS,
    });

    const requested: Array<string | null> = [];
    (serviceAfterRestart as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      if (since === target) return { items: [], nextCursor: target };
      if (since === persistedReplay) {
        return {
          items: [projection('new', '2026-08-14T20:01:00.000Z')],
          nextCursor: target,
        };
      }
      throw new Error(`unexpected cursor ${String(since)}`);
    });

    await serviceAfterRestart.pollOnce();

    expect(requested).toEqual([target, persistedReplay]);
    expect(store.current).toBe(target);
    expect(store.replay).toBeNull();
  });

  it('pauses replay execution but extends its target and settle horizon on saturated forward progress', async () => {
    const highWater = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const forward = cursor('2026-08-14T20:00:02.000Z', 'https://pod.example/b/profile/card#me');
    const replayCursor = cursor('2026-08-14T19:59:20.000Z', 'https://pod.example/replay/profile/card#me');
    const store = makeCursorStore(highWater);
    store.replay = {
      cursor: replayCursor,
      baseCursor: replayCursor,
      targetCursor: highWater,
      settleUntilMs: NOW_MS + 1_000,
    };

    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
      now: () => NOW_MS,
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
    expect(store.replay).toEqual({
      cursor: replayCursor,
      baseCursor: replayCursor,
      targetCursor: forward,
      settleUntilMs: NOW_MS + 60_000,
    });
  });

  it('covers the true start-of-stream boundary during a saturated bootstrap page', async () => {
    const forward = cursor('2026-08-14T20:10:00.000Z', 'https://pod.example/b/profile/card#me');
    const store = makeCursorStore(null);
    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
      now: () => NOW_MS,
    });

    const requested: Array<string | null> = [];
    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      expect(since).toBeNull();
      return {
        items: [
          projection('a', '2026-08-14T20:00:00.000Z'),
          projection('b', '2026-08-14T20:10:00.000Z'),
        ],
        nextCursor: forward,
      };
    });

    await service.pollOnce();

    expect(requested).toEqual([null]);
    expect(store.current).toBe(forward);
    expect(store.replay).toEqual({
      cursor: null,
      baseCursor: null,
      targetCursor: forward,
      settleUntilMs: NOW_MS + 60_000,
    });
  });

  it('re-sweeps the replay base until the late-arrival horizon has elapsed', async () => {
    const highWater = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const base = cursor('2026-08-14T19:59:00.000Z', '\u0000');
    const nearTarget = cursor('2026-08-14T19:59:50.000Z', 'https://pod.example/y/profile/card#me');
    const store = makeCursorStore(highWater);
    store.replay = {
      cursor: nearTarget,
      baseCursor: base,
      targetCursor: highWater,
      settleUntilMs: NOW_MS + 10_000,
    };
    let nowMs = NOW_MS;

    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
      now: () => nowMs,
    });

    const requested: Array<string | null> = [];
    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      requested.push(since);
      if (since === highWater) return { items: [], nextCursor: highWater };
      if (since === nearTarget || since === base) {
        return {
          items: [projection('z', '2026-08-14T20:00:00.000Z')],
          nextCursor: highWater,
        };
      }
      throw new Error(`unexpected cursor ${String(since)}`);
    });

    await service.pollOnce();
    expect(store.replay?.cursor).toBe(base);
    expect(store.replay?.baseCursor).toBe(base);

    nowMs = NOW_MS + 10_001;
    await service.pollOnce();

    expect(requested).toEqual([highWater, nearTarget, highWater, base]);
    expect(store.replay).toBeNull();
  });

  it('creates replay coverage from the previous durable cursor before a large saturated jump', async () => {
    const highWater = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const forward = cursor('2026-08-14T20:10:00.000Z', 'https://pod.example/b/profile/card#me');
    const store = makeCursorStore(highWater);
    const service = new IdentityWarmupService({
      backendBaseUrl: 'http://127.0.0.1:3000',
      bearerToken: 'test-token',
      identityBindingRepository: makeRepository(),
      cursorStore: store,
      batchLimit: 2,
      replayOverlapMs: 60_000,
      now: () => NOW_MS,
    });

    (service as unknown as MutableWarmup).fetchChangesWithRetry = vi.fn(async since => {
      expect(since).toBe(highWater);
      return {
        items: [
          projection('a', '2026-08-14T20:05:00.000Z'),
          projection('b', '2026-08-14T20:10:00.000Z'),
        ],
        nextCursor: forward,
      };
    });

    await service.pollOnce();

    expect(store.current).toBe(forward);
    expect(store.replay?.targetCursor).toBe(forward);
    expect(store.replay?.baseCursor).toBe(store.replay?.cursor);
    const replayStart = JSON.parse(
      Buffer.from(store.replay!.cursor!, 'base64url').toString('utf8')
    ) as { updatedAt: string };
    expect(replayStart.updatedAt).toBe('2026-08-14T19:59:00.000Z');
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
      now: () => NOW_MS,
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
