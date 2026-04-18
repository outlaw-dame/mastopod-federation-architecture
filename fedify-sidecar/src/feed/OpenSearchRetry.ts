export interface OpenSearchRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface OpenSearchRetryEvent {
  attempt: number;
  nextDelayMs: number;
  error: unknown;
}

const DEFAULT_POLICY: OpenSearchRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 150,
  maxDelayMs: 2_000,
  jitterRatio: 0.2,
};

export async function withOpenSearchRetry<T>(
  operation: () => Promise<T>,
  policy: Partial<OpenSearchRetryPolicy> = {},
  onRetry?: (event: OpenSearchRetryEvent) => void,
): Promise<T> {
  const retryPolicy = { ...DEFAULT_POLICY, ...policy };

  let attempt = 0;
  let delayMs = retryPolicy.baseDelayMs;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (attempt >= retryPolicy.maxAttempts || !isRetryableOpenSearchError(error)) {
        throw error;
      }

      const jitterBound = Math.max(0, retryPolicy.jitterRatio);
      const jitterMultiplier = 1 + (Math.random() * (jitterBound * 2) - jitterBound);
      const sleepMs = Math.min(delayMs * jitterMultiplier, retryPolicy.maxDelayMs);
      onRetry?.({
        attempt,
        nextDelayMs: sleepMs,
        error,
      });
      await sleep(sleepMs);
      delayMs = Math.min(delayMs * 2, retryPolicy.maxDelayMs);
    }
  }
}

export function isRetryableOpenSearchError(error: unknown): boolean {
  const statusCode = extractNumeric(
    (error as any)?.statusCode,
    (error as any)?.status,
    (error as any)?.meta?.statusCode,
    (error as any)?.meta?.body?.status,
  );

  if (statusCode !== null && [408, 409, 425, 429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }

  const code = extractString((error as any)?.code)?.toUpperCase();
  if (code && ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }

  const name = extractString((error as any)?.name)?.toLowerCase();
  if (name && ["timeouterror", "requestabortederror"].includes(name)) {
    return true;
  }

  const retryable = (error as any)?.retryable;
  return typeof retryable === "boolean" ? retryable : false;
}

export function classifyOpenSearchRetryReason(error: unknown): string {
  const statusCode = extractNumeric(
    (error as any)?.statusCode,
    (error as any)?.status,
    (error as any)?.meta?.statusCode,
    (error as any)?.meta?.body?.status,
  );
  if (statusCode !== null) {
    return `http_${statusCode}`;
  }

  const code = extractString((error as any)?.code);
  if (code) {
    return sanitizeReasonLabel(code.toLowerCase());
  }

  const name = extractString((error as any)?.name);
  if (name) {
    return sanitizeReasonLabel(name.toLowerCase());
  }

  return "unknown";
}

function extractNumeric(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return null;
}

function extractString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeReasonLabel(value: string): string {
  const normalized = value.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "unknown";
  }
  return normalized.slice(0, 32);
}
