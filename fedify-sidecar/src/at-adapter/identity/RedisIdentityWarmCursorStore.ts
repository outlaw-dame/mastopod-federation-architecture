import type { IdentityWarmCursorStore } from './IdentityWarmupService.js';

const CURSOR_KEY = 'identity:warm:cursor';

export class RedisIdentityWarmCursorStore implements IdentityWarmCursorStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<unknown>;
    }
  ) {}

  async getCursor(): Promise<string | null> {
    const value = await this.redis.get(CURSOR_KEY);
    if (!value) return null;

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async setCursor(cursor: string): Promise<void> {
    const sanitized = cursor.trim();
    if (!sanitized) {
      throw new Error('Identity warm cursor cannot be empty');
    }

    await this.redis.set(CURSOR_KEY, sanitized);
  }
}
