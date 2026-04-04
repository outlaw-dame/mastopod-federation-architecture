import { redis } from './redisClient.js';

export async function enqueue(stream: string, payload: Record<string, any>) {
  await redis.xAdd(stream, '*', payload);
}
