import { redis } from './redisClient.js';
import { logger } from '../logger.js';

export interface WorkerOptions {
  stream: string;
  group: string;
  consumer: string;
  handler: (data: Record<string, string>) => Promise<void>;
}

export async function runWorker(opts: WorkerOptions) {
  try {
    await redis.xGroupCreate(opts.stream, opts.group, '0', { MKSTREAM: true });
  } catch {}

  while (true) {
    const res = await redis.xReadGroup(
      opts.group,
      opts.consumer,
      [{ key: opts.stream, id: '>' }],
      { COUNT: 10, BLOCK: 5000 }
    );

    if (!res) continue;

    for (const stream of res) {
      for (const msg of stream.messages) {
        try {
          await opts.handler(msg.message);
          await redis.xAck(opts.stream, opts.group, msg.id);
        } catch (err) {
          logger.error({ err }, 'Worker failed');
        }
      }
    }
  }
}
