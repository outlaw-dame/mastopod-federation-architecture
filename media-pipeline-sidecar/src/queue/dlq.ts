import { redis } from './redisClient.js';
import { MediaStreams } from '../contracts/MediaStreams.js';

export async function pushToDLQ(payload: Record<string, any>) {
  await redis.xAdd(MediaStreams.DLQ, '*', payload);
}
