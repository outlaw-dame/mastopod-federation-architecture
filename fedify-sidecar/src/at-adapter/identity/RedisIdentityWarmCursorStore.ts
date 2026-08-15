import type {
  IdentityWarmCursorStore,
  IdentityWarmReplayState,
} from './IdentityWarmupService.js';

const CURSOR_KEY = 'identity:warm:cursor';
const REPLAY_KEY = 'identity:warm:replay';

type RedisMultiLike = {
  set(key: string, value: string): RedisMultiLike;
  exec(): Promise<unknown>;
};

export class RedisIdentityWarmCursorStore implements IdentityWarmCursorStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<unknown>;
      del(key: string): Promise<unknown>;
      multi(): RedisMultiLike;
    }
  ) {}

  async getCursor(): Promise<string | null> {
    const value = await this.redis.get(CURSOR_KEY);
    if (!value) return null;

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async setCursor(cursor: string): Promise<void> {
    const sanitized = sanitizeCursor(cursor, 'Identity warm cursor cannot be empty');
    await this.redis.set(CURSOR_KEY, sanitized);
  }

  async getReplayState(): Promise<IdentityWarmReplayState | null> {
    const value = await this.redis.get(REPLAY_KEY);
    if (!value) return null;

    try {
      const parsed = JSON.parse(value) as Partial<IdentityWarmReplayState>;
      const cursor = typeof parsed.cursor === 'string' ? parsed.cursor.trim() : '';
      const targetCursor =
        typeof parsed.targetCursor === 'string' ? parsed.targetCursor.trim() : '';
      if (!cursor || !targetCursor) return null;
      return { cursor, targetCursor };
    } catch {
      return null;
    }
  }

  async setReplayState(state: IdentityWarmReplayState): Promise<void> {
    const normalized = normalizeReplayState(state);
    await this.redis.set(REPLAY_KEY, JSON.stringify(normalized));
  }

  async setCursorAndReplay(cursor: string, state: IdentityWarmReplayState): Promise<void> {
    const normalizedCursor = sanitizeCursor(cursor, 'Identity warm cursor cannot be empty');
    const normalizedReplay = normalizeReplayState(state);

    await this.redis
      .multi()
      .set(REPLAY_KEY, JSON.stringify(normalizedReplay))
      .set(CURSOR_KEY, normalizedCursor)
      .exec();
  }

  async clearReplayState(): Promise<void> {
    await this.redis.del(REPLAY_KEY);
  }
}

function sanitizeCursor(value: string, message: string): string {
  const sanitized = value.trim();
  if (!sanitized) throw new Error(message);
  return sanitized;
}

function normalizeReplayState(state: IdentityWarmReplayState): IdentityWarmReplayState {
  const cursor = state.cursor.trim();
  const targetCursor = state.targetCursor.trim();
  if (!cursor || !targetCursor) {
    throw new Error('Identity warm replay state cannot contain empty cursors');
  }
  return { cursor, targetCursor };
}
