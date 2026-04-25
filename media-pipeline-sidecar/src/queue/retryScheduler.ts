import { randomUUID } from 'node:crypto';
import { config } from '../config/config';
import { logger } from '../logger';
import { errorCode, errorMessage } from '../utils/errorHandling';
import { calculateExponentialBackoffDelayMs } from '../utils/retry';
import { enqueue } from './producer';
import { redis } from './redisClient';

const RETRY_ATTEMPT_FIELD = '_retryAttempt';
const RETRY_AT_FIELD = '_retryAt';
const RETRY_FIRST_FAILED_AT_FIELD = '_retryFirstFailedAt';
const RETRY_LAST_ERROR_CODE_FIELD = '_retryLastErrorCode';
const RETRY_LAST_ERROR_MESSAGE_FIELD = '_retryLastErrorMessage';
const MAX_RETRY_ERROR_MESSAGE_LENGTH = 256;

interface ScheduledRetryMember {
  id: string;
  message: Record<string, string>;
}

export function retryAttemptForMessage(message: Record<string, string>): number {
  const parsed = Number.parseInt(message[RETRY_ATTEMPT_FIELD] || '0', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function canScheduleRetry(message: Record<string, string>): boolean {
  return retryAttemptForMessage(message) < config.workerMaxScheduledRetries;
}

export async function scheduleRetry(
  stream: string,
  message: Record<string, string>,
  error: unknown
): Promise<{ attempt: number; dueAtMs: number }> {
  const nextAttempt = retryAttemptForMessage(message) + 1;
  const delayMs = calculateExponentialBackoffDelayMs(
    nextAttempt - 1,
    config.workerRetryBaseDelayMs,
    config.workerRetryMaxDelayMs
  );
  const dueAtMs = Date.now() + delayMs;
  const scheduledMessage = {
    ...message,
    [RETRY_ATTEMPT_FIELD]: String(nextAttempt),
    [RETRY_AT_FIELD]: new Date(dueAtMs).toISOString(),
    [RETRY_FIRST_FAILED_AT_FIELD]: message[RETRY_FIRST_FAILED_AT_FIELD] || new Date().toISOString(),
    [RETRY_LAST_ERROR_CODE_FIELD]: errorCode(error),
    [RETRY_LAST_ERROR_MESSAGE_FIELD]: truncateRetryErrorMessage(errorMessage(error))
  };

  await redis.zAdd(retrySetKey(stream), [{
    score: dueAtMs,
    value: JSON.stringify({
      id: randomUUID(),
      message: scheduledMessage
    } satisfies ScheduledRetryMember)
  }]);

  return {
    attempt: nextAttempt,
    dueAtMs
  };
}

export async function drainDueRetries(stream: string, limit: number): Promise<number> {
  if (limit <= 0) {
    return 0;
  }

  const retrySet = retrySetKey(stream);
  let drained = 0;

  while (drained < limit) {
    const popped = await redis.sendCommand<string[]>(['ZPOPMIN', retrySet, '1']);
    if (popped.length < 2) {
      break;
    }

    const entryValue = popped[0];
    const entryScore = Number(popped[1]);
    if (!Number.isFinite(entryScore)) {
      logger.warn({ stream }, 'worker-retry-discarded-invalid-score');
      continue;
    }

    if (entryScore > Date.now()) {
      await redis.zAdd(retrySet, [{ score: entryScore, value: entryValue }]);
      break;
    }

    const parsed = parseScheduledRetryMember(entryValue);
    if (!parsed) {
      logger.warn({ stream }, 'worker-retry-discarded-invalid-payload');
      continue;
    }

    await enqueue(stream, parsed.message);
    drained += 1;
  }

  return drained;
}

function retrySetKey(stream: string): string {
  return `${stream}:retry`;
}

function parseScheduledRetryMember(value: string): ScheduledRetryMember | null {
  try {
    const parsed = JSON.parse(value) as Partial<ScheduledRetryMember>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || !parsed.message || typeof parsed.message !== 'object') {
      return null;
    }

    const messageEntries = Object.entries(parsed.message)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string');

    return {
      id: parsed.id,
      message: Object.fromEntries(messageEntries)
    };
  } catch {
    return null;
  }
}

function truncateRetryErrorMessage(message: string): string {
  if (message.length <= MAX_RETRY_ERROR_MESSAGE_LENGTH) {
    return message;
  }

  return `${message.slice(0, MAX_RETRY_ERROR_MESSAGE_LENGTH - 3)}...`;
}
