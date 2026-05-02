import { randomInt } from "node:crypto";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function withEntrywayRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (error: unknown) => boolean,
): Promise<T> {
  const maxAttempts = clampInteger(policy.maxAttempts, 1, 8);
  const baseDelayMs = clampInteger(policy.baseDelayMs, 25, 10_000);
  const maxDelayMs = clampInteger(policy.maxDelayMs, baseDelayMs, 30_000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      await sleep(computeFullJitterDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry operation failed");
}

export function isRetryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  const candidate = error as { code?: unknown; name?: unknown; message?: unknown; retryable?: unknown };
  if (candidate?.retryable === true) {
    return true;
  }

  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(code)) {
    return true;
  }

  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort|timed out|timeout|fetch failed|network|socket|temporar|rate limit/i.test(message);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function computeFullJitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return randomInt(0, Math.max(1, cap + 1));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
