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
    const sanitized = sanitizeRequiredCursor(cursor, 'Identity warm cursor cannot be empty');
    await this.redis.set(CURSOR_KEY, sanitized);
  }

  async getReplayState(): Promise<IdentityWarmReplayState | null> {
    const value = await this.redis.get(REPLAY_KEY);
    if (!value) return null;

    try {
      const parsed = JSON.parse(value) as Partial<IdentityWarmReplayState>;
      const targetCursor = normalizeRequiredCursor(parsed.targetCursor);
      if (!targetCursor) return null;

      const cursor = normalizeNullableCursor(parsed.cursor);
      if (parsed.cursor !== null && typeof parsed.cursor !== 'string') return null;

      const hasBaseCursor = Object.prototype.hasOwnProperty.call(parsed, 'baseCursor');
      const baseCursor = hasBaseCursor
        ? normalizeNullableCursor(parsed.baseCursor)
        : cursor;
      if (hasBaseCursor && parsed.baseCursor !== null && typeof parsed.baseCursor !== 'string') {
        return null;
      }

      const settleUntilMs =
        typeof parsed.settleUntilMs === 'number' && Number.isFinite(parsed.settleUntilMs)
          ? Math.max(0, Math.trunc(parsed.settleUntilMs))
          : undefined;
      const passStartedAtMs =
        typeof parsed.passStartedAtMs === 'number' && Number.isFinite(parsed.passStartedAtMs)
          ? Math.max(0, Math.trunc(parsed.passStartedAtMs))
          : undefined;

      return {
        cursor,
        baseCursor,
        targetCursor,
        settleUntilMs,
        passStartedAtMs,
      };
    } catch {
      return null;
    }
  }

  async setReplayState(state: IdentityWarmReplayState): Promise<void> {
    const normalized = normalizeReplayState(state);
    await this.redis.set(REPLAY_KEY, JSON.stringify(normalized));
  }

  async setCursorAndReplay(cursor: string, state: IdentityWarmReplayState): Promise<void> {
    const normalizedCursor = sanitizeRequiredCursor(cursor, 'Identity warm cursor cannot be empty');
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

function sanitizeRequiredCursor(value: string, message: string): string {
  const sanitized = value.trim();
  if (!sanitized) throw new Error(message);
  return sanitized;
}

function normalizeRequiredCursor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value.trim();
  return sanitized || null;
}

function normalizeNullableCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const sanitized = value.trim();
  return sanitized || null;
}

function normalizeReplayState(state: IdentityWarmReplayState): IdentityWarmReplayState {
  const targetCursor = sanitizeRequiredCursor(
    state.targetCursor,
    'Identity warm replay state requires a target cursor'
  );
  const cursor = normalizeNullableCursor(state.cursor);
  const baseCursor = Object.prototype.hasOwnProperty.call(state, 'baseCursor')
    ? normalizeNullableCursor(state.baseCursor)
    : cursor;
  const settleUntilMs =
    typeof state.settleUntilMs === 'number' && Number.isFinite(state.settleUntilMs)
      ? Math.max(0, Math.trunc(state.settleUntilMs))
      : 0;
  const passStartedAtMs =
    typeof state.passStartedAtMs === 'number' && Number.isFinite(state.passStartedAtMs)
      ? Math.max(0, Math.trunc(state.passStartedAtMs))
      : undefined;

  return {
    cursor,
    baseCursor,
    targetCursor,
    settleUntilMs,
    passStartedAtMs,
  };
}
