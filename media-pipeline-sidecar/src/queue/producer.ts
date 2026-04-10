import { redis } from './redisClient';
import { config } from '../config/config';

export async function enqueue(stream: string, payload: Record<string, string>): Promise<void> {
  await redis.xAdd(stream, '*', payload, {
    TRIM: {
      strategy: 'MAXLEN',
      strategyModifier: '~',
      threshold: config.streamMaxLen
    }
  });
}
