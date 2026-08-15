import { describe, expect, it, vi } from 'vitest';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import type {
  BackendIdentityChangesResponse,
  BackendIdentityProjection,
} from './IdentityBindingSyncService.js';
import {
  IdentityWarmupService,
  type IdentityWarmCursorStore,
  type IdentityWarmReplayState,
} from './IdentityWarmupService.js';
import { RedisIdentityWarmCursorStore } from './RedisIdentityWarmCursorStore.js';

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

function makeCursorStore(current: string, replay: IdentityWarmReplayState): TestCursorStore {
  return {
    current,
    replay: { ...replay },
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

describe('IdentityWarmupService durable replay pass proof', () => {
  it('persists a post-horizon pass start across pages and clears after that full pass completes', async () => {
    const target = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const base = cursor('2026-08-14T19:59:00.000Z', '\u0000');
    const page1 = cursor('2026-08-14T19:59:30.000Z', 'https://pod.example/m/profile/card#me');
    const store = makeCursorStore(target, {
      cursor: base,
      baseCursor: base,
      targetCursor: target,
      settleUntilMs: NOW_MS - 1,
    });
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
      if (since === target) return { items: [], nextCursor: target };
      if (since === base) {
        return {
          items: [
            projection('a', '2026-08-14T19:59:10.000Z'),
            projection('m', '2026-08-14T19:59:30.000Z'),
          ],
          nextCursor: page1,
        };
      }
      if (since === page1) {
        return {
          items: [projection('z', '2026-08-14T20:00:00.000Z')],
          nextCursor: target,
        };
      }
      throw new Error(`unexpected cursor ${String(since)}`);
    });

    await service.pollOnce();

    expect(store.replay).toEqual({
      cursor: page1,
      baseCursor: base,
      targetCursor: target,
      settleUntilMs: NOW_MS - 1,
      passStartedAtMs: NOW_MS,
    });

    await service.pollOnce();

    expect(requested).toEqual([target, base, target, page1]);
    expect(store.replay).toBeNull();
  });

  it('invalidates the pass-start proof when forward progress extends the replay target', async () => {
    const target = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');
    const forward = cursor('2026-08-14T20:00:02.000Z', 'https://pod.example/new/profile/card#me');
    const base = cursor('2026-08-14T19:59:00.000Z', '\u0000');
    const page1 = cursor('2026-08-14T19:59:30.000Z', 'https://pod.example/m/profile/card#me');
    const store = makeCursorStore(target, {
      cursor: page1,
      baseCursor: base,
      targetCursor: target,
      settleUntilMs: NOW_MS - 1,
      passStartedAtMs: NOW_MS - 10_000,
    });
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
      expect(since).toBe(target);
      return {
        items: [
          projection('next-a', '2026-08-14T20:00:01.000Z'),
          projection('new', '2026-08-14T20:00:02.000Z'),
        ],
        nextCursor: forward,
      };
    });

    await service.pollOnce();

    expect(store.current).toBe(forward);
    expect(store.replay?.cursor).toBe(page1);
    expect(store.replay?.targetCursor).toBe(forward);
    expect(store.replay?.settleUntilMs).toBe(NOW_MS + 60_000);
    expect(store.replay?.passStartedAtMs).toBeUndefined();
  });
});

describe('RedisIdentityWarmCursorStore replay pass persistence', () => {
  it('round-trips passStartedAtMs with the replay state', async () => {
    const storage = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => storage.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => Number(storage.delete(key))),
      multi: vi.fn(() => {
        const commands: Array<[string, string]> = [];
        return {
          set(key: string, value: string) {
            commands.push([key, value]);
            return this;
          },
          async exec() {
            for (const [key, value] of commands) storage.set(key, value);
            return [];
          },
        };
      }),
    };
    const store = new RedisIdentityWarmCursorStore(redis);
    const base = cursor('2026-08-14T19:59:00.000Z', '\u0000');
    const target = cursor('2026-08-14T20:00:00.000Z', 'https://pod.example/z/profile/card#me');

    await store.setReplayState({
      cursor: base,
      baseCursor: base,
      targetCursor: target,
      settleUntilMs: NOW_MS - 1,
      passStartedAtMs: NOW_MS,
    });

    await expect(store.getReplayState()).resolves.toEqual({
      cursor: base,
      baseCursor: base,
      targetCursor: target,
      settleUntilMs: NOW_MS - 1,
      passStartedAtMs: NOW_MS,
    });
  });
});