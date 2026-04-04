import { redis } from './redisClient.js';
import { logger } from '../logger.js';
import { pushToDLQ } from './dlq.js';
import { getBackoffDelay } from '../utils/retry.js';

export async function runSecureWorker(opts: any) {
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
        const attempt = parseInt(msg.message.attempt || '0', 10);

        try {
          await opts.handler(msg.message);
          await redis.xAck(opts.stream, opts.group, msg.id);
        } catch (err) {
          logger.error({ err }, 'Worker failure');

          if (attempt >= 5) {
            await pushToDLQ({ ...msg.message, error: String(err) });
            await redis.xAck(opts.stream, opts.group, msg.id);
            continue;
          }

          const delay = getBackoffDelay(attempt);

          await new Promise(r => setTimeout(r, delay));

          await redis.xAdd(opts.stream, '*', {
            ...msg.message,
            attempt: String(attempt + 1)
          });

          await redis.xAck(opts.stream, opts.group, msg.id);
        }
      }
    }
  }
}
