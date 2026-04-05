import type { RetryClassifier, RetryPolicy } from "../ports/ProtocolBridgePorts.js";

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  classifier: RetryClassifier,
): Promise<T> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      const canRetry = classifier.isTransient(error) && attempt < policy.maxAttempts;
      if (!canRetry) {
        throw error;
      }

      const delayMs = computeFullJitterDelay(attempt, policy.baseDelayMs, policy.maxDelayMs);
      await sleep(delayMs);
    }
  }
}

export class DefaultRetryClassifier implements RetryClassifier {
  public isTransient(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const candidate = error as {
      code?: string;
      name?: string;
      message?: string;
      status?: number;
      statusCode?: number;
      retryable?: boolean;
      transient?: boolean;
    };

    if (candidate.retryable === true || candidate.transient === true) {
      return true;
    }

    const status = candidate.status ?? candidate.statusCode;
    if (typeof status === "number" && [408, 425, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    const code = candidate.code ?? candidate.name ?? "";
    if ([
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
      "AbortError",
    ].includes(code)) {
      return true;
    }

    const message = candidate.message?.toLowerCase() ?? "";
    return message.includes("timeout") || message.includes("temporar") || message.includes("rate limit");
  }
}

function computeFullJitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * Math.max(cap, 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
