import { describe, expect, it, vi } from 'vitest';
import { RedisIdentityWarmCursorStore } from './RedisIdentityWarmCursorStore.js';

class FakeMulti {
  readonly commands: Array<[string, string, string]> = [];
  readonly exec = vi.fn(async () => []);

  set(key: string, value: string): FakeMulti {
    this.commands.push(['set', key, value]);
    return this;
  }
}

describe('RedisIdentityWarmCursorStore atomic commit', () => {
  it('queues replay state and forward cursor in one MULTI/EXEC', async () => {
    const multi = new FakeMulti();
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      multi: vi.fn(() => multi),
    };
    const store = new RedisIdentityWarmCursorStore(redis);

    await store.setCursorAndReplay(' next-cursor ', {
      cursor: ' replay-cursor ',
      targetCursor: ' target-cursor ',
    });

    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(multi.commands).toEqual([
      [
        'set',
        'identity:warm:replay',
        JSON.stringify({ cursor: 'replay-cursor', targetCursor: 'target-cursor' }),
      ],
      ['set', 'identity:warm:cursor', 'next-cursor'],
    ]);
    expect(multi.exec).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
