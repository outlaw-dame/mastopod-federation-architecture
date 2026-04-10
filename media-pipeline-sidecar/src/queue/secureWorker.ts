import { hostname } from 'node:os';
import { config } from '../config/config';
import { logger } from '../logger';
import { pushToDlq } from './dlq';
import { initRedis, redis } from './redisClient';

/**
 * MEDIA PIPELINE RULE:
 * This service MUST NOT make moderation decisions.
 * Only emits raw safety signals.
 * Policy decisions are handled by MRF.
 */
export async function runSecureWorker(params: {
  stream: string;
  group: string;
  consumer: string;
  handler: (message: Record<string, string>) => Promise<void>;
}): Promise<void> {
  await initRedis();
  const consumerId = `${params.consumer}-${hostname()}-${process.pid}`;
  let failureStreak = 0;

  try {
    await redis.xGroupCreate(params.stream, params.group, '0', { MKSTREAM: true });
  } catch {
    // group already exists
  }

  while (true) {
    try {
      const reclaimed = await redis.xAutoClaim(
        params.stream,
        params.group,
        consumerId,
        config.pendingMinIdleMs,
        '0-0',
        { COUNT: config.pendingClaimBatchSize }
      );

      for (const message of reclaimed.messages) {
        if (!message) continue;
        await processMessage(params.stream, params.group, message.id, message.message, params.handler);
      }

      const result = await redis.xReadGroup(
        params.group,
        consumerId,
        [{ key: params.stream, id: '>' }],
        { COUNT: 10, BLOCK: 5000 }
      );

      if (!result) continue;

      for (const stream of result) {
        for (const message of stream.messages) {
          await processMessage(params.stream, params.group, message.id, message.message, params.handler);
        }
      }

      failureStreak = 0;
    } catch (err) {
      failureStreak += 1;
      const backoffMs = calculateBackoffMs(failureStreak);
      logger.error({
        stream: params.stream,
        group: params.group,
        consumer: consumerId,
        backoffMs,
        failureStreak,
        err
      }, 'worker-loop-error');
      await sleep(backoffMs);
    }
  }
}

async function processMessage(
  stream: string,
  group: string,
  messageId: string,
  message: Record<string, string>,
  handler: (message: Record<string, string>) => Promise<void>
): Promise<void> {
  try {
    await handler(message);
    await redis.xAck(stream, group, messageId);
  } catch (err) {
    await pushToDlq({
      stream,
      messageId,
      error: err instanceof Error ? err.message : 'unknown-error',
      payload: JSON.stringify(message)
    });
    await redis.xAck(stream, group, messageId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateBackoffMs(failureStreak: number): number {
  const baseMs = 500;
  const capMs = 30_000;
  const exponentialMs = Math.min(capMs, baseMs * 2 ** Math.max(0, failureStreak - 1));
  const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(exponentialMs * 0.2)));
  return exponentialMs + jitterMs;
}
