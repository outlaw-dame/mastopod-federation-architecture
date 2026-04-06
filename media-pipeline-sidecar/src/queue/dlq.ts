import { MediaStreams } from '../contracts/MediaStreams';
import { redis } from './redisClient';

export async function pushToDlq(payload: Record<string, string>): Promise<void> {
  await redis.xAdd(MediaStreams.DLQ, '*', payload);
}
