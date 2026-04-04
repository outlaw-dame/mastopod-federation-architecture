import { createClient } from 'redis';
import { logger } from '../logger.js';

export const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

redis.on('error', (err) => logger.error({ err }, 'Redis error'));

export async function initRedis() {
  if (!redis.isOpen) {
    await redis.connect();
    logger.info('Redis connected');
  }
}
