import type { IdentityWarmCursorStore } from './IdentityWarmupService.js';

export const DEFAULT_IDENTITY_WARM_CURSOR_KEY = 'identity:warm:cursor';

export class RedisIdentityWarmCursorStore implements IdentityWarmCursorStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<unknown>;
      del(...keys: string[]): Promise<unknown>;
    },
    private readonly key: string = DEFAULT_IDENTITY_WARM_CURSOR_KEY
  ) {}

  async getCursor(): Promise<string | null> {
    return this.redis.get(this.key);
  }

  async setCursor(cursor: string | null): Promise<void> {
    if (cursor && cursor.length > 0) {
      await this.redis.set(this.key, cursor);
      return;
    }

    await this.redis.del(this.key);
  }
}
