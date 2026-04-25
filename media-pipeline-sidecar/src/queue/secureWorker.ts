import { hostname } from 'node:os';
import { config } from '../config/config';
import { logger } from '../logger';
import { pushToDlq } from './dlq';
import { initRedis, redis } from './redisClient';
import { canScheduleRetry, drainDueRetries, retryAttemptForMessage, scheduleRetry } from './retryScheduler';
import { errorCode, errorMessage, errorStatusCode, isRetryableError } from '../utils/errorHandling';
import { sanitizeMessageForDlq } from '../utils/messageSanitization';
import { calculateExponentialBackoffDelayMs, sleep } from '../utils/retry';

interface WorkerEnvelope {
  id: string;
  message: Record<string, string>;
}

interface BatchHandlerResult {
  handledMessageIds?: string[];
  failedMessages?: WorkerEnvelope[];
}

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
  readCount?: number;
  blockMs?: number;
  stopSignal?: AbortSignal;
  handler: (message: Record<string, string>) => Promise<void>;
  batchHandler?: (messages: WorkerEnvelope[]) => Promise<BatchHandlerResult | void>;
}): Promise<void> {
  await initRedis();
  const consumerId = `${params.consumer}-${hostname()}-${process.pid}`;
  let failureStreak = 0;
  const readCount = params.readCount ?? config.workerReadCount;
  const blockMs = params.blockMs ?? config.workerBlockMs;

  try {
    await redis.xGroupCreate(params.stream, params.group, '0', { MKSTREAM: true });
  } catch {
    // group already exists
  }

  while (!params.stopSignal?.aborted) {
    try {
      await drainDueRetries(params.stream, Math.max(readCount, config.pendingClaimBatchSize));

      const reclaimed = await redis.xAutoClaim(
        params.stream,
        params.group,
        consumerId,
        config.pendingMinIdleMs,
        '0-0',
        { COUNT: Math.max(readCount, config.pendingClaimBatchSize) }
      );

      const reclaimedMessages = reclaimed.messages
        .filter((message): message is WorkerEnvelope => Boolean(message))
        .map((message) => ({ id: message.id, message: message.message }));

      if (reclaimedMessages.length > 0) {
        await processMessages(params, reclaimedMessages);
      }

      const result = await redis.xReadGroup(
        params.group,
        consumerId,
        [{ key: params.stream, id: '>' }],
        { COUNT: readCount, BLOCK: blockMs }
      );

      if (!result) continue;
      if (params.stopSignal?.aborted) {
        break;
      }

      for (const stream of result) {
        const streamMessages = stream.messages.map((message) => ({
          id: message.id,
          message: message.message
        }));
        if (streamMessages.length > 0) {
          await processMessages(params, streamMessages);
        }
      }

      failureStreak = 0;
    } catch (err) {
      if (params.stopSignal?.aborted) {
        break;
      }
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

async function processMessages(
  params: {
    stream: string;
    group: string;
    consumer: string;
    handler: (message: Record<string, string>) => Promise<void>;
    batchHandler?: (messages: WorkerEnvelope[]) => Promise<BatchHandlerResult | void>;
  },
  messages: WorkerEnvelope[]
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  if (params.batchHandler && messages.length > 1) {
    try {
      const result = await params.batchHandler(messages);
      const handledMessageIds = result?.handledMessageIds ?? messages.map((message) => message.id);
      const failedMessages = result?.failedMessages ?? [];

      if (handledMessageIds.length > 0) {
        await ackMessageIds(params.stream, params.group, handledMessageIds);
      }

      for (const failedMessage of failedMessages) {
        await processMessage(params.stream, params.group, failedMessage, params.handler);
      }
      return;
    } catch (err) {
      logger.warn({
        stream: params.stream,
        group: params.group,
        count: messages.length,
        error: errorMessage(err),
        code: errorCode(err)
      }, 'worker-batch-fallback-to-single');
    }
  }

  for (const envelope of messages) {
    await processMessage(params.stream, params.group, envelope, params.handler);
  }
}

async function processMessage(
  stream: string,
  group: string,
  envelope: WorkerEnvelope,
  handler: (message: Record<string, string>) => Promise<void>
): Promise<void> {
  try {
    await handler(envelope.message);
    await ackMessageIds(stream, group, [envelope.id]);
  } catch (err) {
    const retryable = isRetryableError(err);
    const retryAttempts = retryAttemptForMessage(envelope.message);

    if (retryable && canScheduleRetry(envelope.message)) {
      try {
        const scheduled = await scheduleRetry(stream, envelope.message, err);
        logger.warn({
          stream,
          group,
          messageId: envelope.id,
          retryAttempt: scheduled.attempt,
          dueAt: new Date(scheduled.dueAtMs).toISOString(),
          errorCode: errorCode(err)
        }, 'worker-message-scheduled-retry');
        await ackMessageIds(stream, group, [envelope.id]);
        return;
      } catch (scheduleError) {
        logger.error({
          stream,
          group,
          messageId: envelope.id,
          retryAttempt: retryAttempts + 1,
          error: errorMessage(scheduleError),
          errorCode: errorCode(scheduleError)
        }, 'worker-message-retry-schedule-failed');
      }
    }

    const dlqPayload = {
      stream,
      messageId: envelope.id,
      error: errorMessage(err),
      errorCode: errorCode(err),
      retryable: String(retryable),
      retryAttempts: String(retryAttempts),
      retriesExhausted: String(retryable && !canScheduleRetry(envelope.message)),
      statusCode: String(errorStatusCode(err) || ''),
      failedAt: new Date().toISOString(),
      payload: JSON.stringify(sanitizeMessageForDlq(envelope.message))
    };

    await pushToDlq(dlqPayload);
    await ackMessageIds(stream, group, [envelope.id]);
  }
}

async function ackMessageIds(stream: string, group: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  if (messageIds.length === 1) {
    await redis.xAck(stream, group, messageIds[0]);
    return;
  }

  await redis.sendCommand(['XACK', stream, group, ...messageIds]);
}

function calculateBackoffMs(failureStreak: number): number {
  return calculateExponentialBackoffDelayMs(
    Math.max(0, failureStreak - 1),
    500,
    30_000
  );
}
