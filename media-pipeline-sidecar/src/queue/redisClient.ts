import { createClient } from 'redis';
import { config } from '../config/config';

export const redis = createClient({ url: config.redisUrl });

export async function initRedis(): Promise<void> {
  if (!redis.isOpen) {
    await redis.connect();
  }
}
