import { MediaStreams } from '../contracts/MediaStreams';
import { redis } from './redisClient';
import { config } from '../config/config';

export async function pushToDlq(payload: Record<string, string>): Promise<void> {
  await redis.xAdd(MediaStreams.DLQ, '*', payload, {
    TRIM: {
      strategy: 'MAXLEN',
      strategyModifier: '~',
      threshold: config.dlqMaxLen
    }
  });
}
