import { createClient } from 'redis';
import { config } from '../config/config';

export const redis = createClient({
  url: config.redisUrl,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
  }
});

redis.on('error', (err) => {
  console.error('[redis-error]', err);
});

export async function initRedis(): Promise<void> {
  if (!redis.isOpen && !redis.isReady) {
    await redis.connect();
  }
}
