import { createClient } from 'redis';
import { config } from '../config/config';
import { logger } from '../logger';

export const redis = createClient({
  url: config.redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      const cappedRetries = Math.min(retries, 8);
      const baseDelayMs = Math.min(30_000, 250 * 2 ** cappedRetries);
      const jitterMs = Math.floor(Math.random() * 250);
      return baseDelayMs + jitterMs;
    }
  }
});

redis.on('error', (err) => {
  logger.error({ err }, 'redis-error');
});

redis.on('reconnecting', () => {
  logger.warn('redis-reconnecting');
});

redis.on('ready', () => {
  logger.info('redis-ready');
});

export async function initRedis(): Promise<void> {
  if (!redis.isOpen && !redis.isReady) {
    await redis.connect();
  }
}
