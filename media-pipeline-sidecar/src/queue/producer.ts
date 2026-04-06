import { redis } from './redisClient';

export async function enqueue(stream: string, payload: Record<string, string>): Promise<void> {
  await redis.xAdd(stream, '*', payload);
}
