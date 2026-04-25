import { isLikelyTransientError } from './errorHandling';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateExponentialBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const boundedAttempt = Math.max(0, attempt);
  const exponentialDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** boundedAttempt);
  return Math.floor(Math.random() * Math.max(1, exponentialDelayMs + 1));
}

export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const shouldRetry = options.shouldRetry ?? isLikelyTransientError;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) {
        throw error;
      }

      const sleepMs = calculateExponentialBackoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      await sleep(sleepMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry operation failed');
}
