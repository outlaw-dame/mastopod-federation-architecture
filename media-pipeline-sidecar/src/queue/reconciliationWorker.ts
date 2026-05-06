/**
 * DLQ Reconciliation Worker
 *
 * Periodically reads messages from the dead-letter queue (DLQ) and
 * re-enqueues those that:
 *   - Are within the maximum age window (dlqReconcileMaxAgeMs)
 *   - Have a retryable error code (retriesExhausted === 'false' or missing)
 *
 * Messages older than dlqReconcileMaxAgeMs are permanently abandoned and
 * ACKed so they are eventually trimmed by MAXLEN.
 *
 * Self-healing design:
 *   - Uses its own Redis consumer group on the DLQ stream.
 *   - Full-jitter exponential backoff between reconciliation passes.
 *   - Never throws past its own loop — any error is logged and the loop
 *     continues after a backoff delay.
 */

import { MediaStreams } from '../contracts/MediaStreams';
import { config } from '../config/config';
import { logger } from '../logger';
import { initRedis, redis } from './redisClient';
import { enqueue } from './producer';
import { calculateExponentialBackoffDelayMs, sleep } from '../utils/retry';

const RECONCILE_GROUP = 'dlq-reconcile';
const RECONCILE_CONSUMER = 'reconcile-worker-1';
const RECONCILE_READ_COUNT = 50;
const RECONCILE_IDLE_MS = 60_000;

async function ensureGroup(): Promise<void> {
  try {
    await redis.xGroupCreate(MediaStreams.DLQ, RECONCILE_GROUP, '0', { MKSTREAM: true });
  } catch {
    // group already exists
  }
}

async function runReconciliationPass(): Promise<void> {
  const messages = await redis.xReadGroup(
    RECONCILE_GROUP,
    RECONCILE_CONSUMER,
    [{ key: MediaStreams.DLQ, id: '>' }],
    { COUNT: RECONCILE_READ_COUNT, BLOCK: RECONCILE_IDLE_MS }
  );

  if (!messages) return;

  for (const streamResult of messages) {
    for (const entry of streamResult.messages) {
      const msg = entry.message;
      const msgId = entry.id;

      try {
        await reconcileEntry(msgId, msg);
      } catch (err) {
        logger.warn(
          { msgId, err },
          'dlq-reconcile-entry-error'
        );
        // ACK to avoid re-processing a message that consistently errors
        await redis.xAck(MediaStreams.DLQ, RECONCILE_GROUP, msgId);
      }
    }
  }
}

async function reconcileEntry(msgId: string, msg: Record<string, string>): Promise<void> {
  const failedAt = msg.failedAt ? new Date(msg.failedAt).getTime() : 0;
  const ageMs = Date.now() - failedAt;
  const retriesExhausted = msg.retriesExhausted === 'true';
  const retryable = msg.retryable !== 'false';
  const originalStream = msg.stream;

  // Always ACK — DLQ entries are append-only and this just marks the
  // reconciliation consumer's position; the entries stay visible in the stream.
  await redis.xAck(MediaStreams.DLQ, RECONCILE_GROUP, msgId);

  if (!originalStream) {
    logger.warn({ msgId }, 'dlq-reconcile-no-stream');
    return;
  }

  if (ageMs > config.dlqReconcileMaxAgeMs) {
    logger.info(
      { msgId, originalStream, ageMs },
      'dlq-reconcile-abandoned-too-old'
    );
    return;
  }

  if (retriesExhausted || !retryable) {
    logger.info(
      { msgId, originalStream, retriesExhausted, retryable },
      'dlq-reconcile-skipped-non-retryable'
    );
    return;
  }

  // Re-enqueue original payload to its origin stream
  let payload: Record<string, string>;
  try {
    payload = JSON.parse(msg.payload || '{}');
  } catch {
    logger.warn({ msgId }, 'dlq-reconcile-invalid-payload');
    return;
  }

  if (!payload || typeof payload !== 'object') {
    return;
  }

  await enqueue(originalStream, payload as Record<string, string>);
  logger.info(
    { msgId, originalStream, ageMs },
    'dlq-reconcile-requeued'
  );
}

async function main(): Promise<void> {
  await initRedis();
  await ensureGroup();
  logger.info('dlq-reconcile-worker-started');

  let failureStreak = 0;

  for (;;) {
    try {
      await runReconciliationPass();
      failureStreak = 0;
    } catch (err) {
      failureStreak += 1;
      const backoffMs = calculateExponentialBackoffDelayMs(
        Math.max(0, failureStreak - 1),
        1000,
        60_000
      );
      logger.error({ err, failureStreak, backoffMs }, 'dlq-reconcile-pass-error');
      await sleep(backoffMs);
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'dlq-reconcile-startup-error');
  process.exit(1);
});
