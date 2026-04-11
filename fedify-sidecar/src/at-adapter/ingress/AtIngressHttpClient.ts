import { sanitizeJsonObject } from "../../utils/safe-json.js";

export interface AtIngressHttpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface AtIngressJsonRequestOptions {
  accept?: string;
  maxBytes?: number;
}

export interface AtIngressTextRequestOptions {
  accept?: string;
  maxBytes?: number;
}

export interface AtIngressBytesRequestOptions {
  accept?: string;
  maxBytes?: number;
}

export class AtIngressHttpError extends Error {
  public constructor(
    message: string,
    public readonly options: {
      status?: number;
      retryable?: boolean;
      code?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AtIngressHttpError";
  }

  public get retryable(): boolean {
    return this.options.retryable === true;
  }

  public get status(): number | undefined {
    return this.options.status;
  }

  public get code(): string | undefined {
    return this.options.code;
  }
}

export class AtIngressHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  public constructor(options: AtIngressHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = clampInteger(options.timeoutMs ?? 8_000, 1_000, 30_000);
    this.maxAttempts = clampInteger(options.maxAttempts ?? 3, 1, 6);
    this.baseBackoffMs = clampInteger(options.baseBackoffMs ?? 200, 50, 5_000);
    this.maxBackoffMs = clampInteger(options.maxBackoffMs ?? 5_000, 250, 60_000);
  }

  public async requestJson(
    url: string,
    options: AtIngressJsonRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request(url, options.accept ?? "application/json");
    const bytes = await readResponseBytes(response, options.maxBytes ?? 256_000);

    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return sanitizeJsonObject(parsed, {
        maxBytes: options.maxBytes ?? 256_000,
        maxDepth: 24,
        maxNodes: 20_000,
        maxArrayLength: 4_000,
        maxObjectKeys: 4_000,
      });
    } catch (error) {
      throw new AtIngressHttpError("Response body was not valid JSON", {
        retryable: false,
        code: "INVALID_JSON",
        cause: error,
      });
    }
  }

  public async requestText(
    url: string,
    options: AtIngressTextRequestOptions = {},
  ): Promise<string> {
    const response = await this.request(url, options.accept ?? "text/plain");
    const bytes = await readResponseBytes(response, options.maxBytes ?? 16_384);
    return Buffer.from(bytes).toString("utf8");
  }

  public async requestBytes(
    url: string,
    options: AtIngressBytesRequestOptions = {},
  ): Promise<Uint8Array> {
    const response = await this.request(url, options.accept ?? "application/octet-stream");
    return readResponseBytes(response, options.maxBytes ?? 32 * 1024 * 1024);
  }

  private async request(url: string, accept: string): Promise<Response> {
    let lastError: AtIngressHttpError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            accept,
          },
          redirect: "follow",
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          throw new AtIngressHttpError(
            `HTTP ${response.status} while requesting ${redactUrl(url)}`,
            {
              status: response.status,
              retryable,
              code: "HTTP_ERROR",
            },
          );
        }

        return response;
      } catch (error) {
        const normalized = normalizeHttpError(error, url);
        lastError = normalized;

        if (!normalized.retryable || attempt >= this.maxAttempts) {
          throw normalized;
        }

        await sleep(fullJitterBackoffMs(attempt, this.baseBackoffMs, this.maxBackoffMs));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new AtIngressHttpError("HTTP request failed");
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (contentLength > maxBytes) {
      throw new AtIngressHttpError(
        `Response exceeded byte limit of ${maxBytes}`,
        { retryable: false, code: "BODY_TOO_LARGE" },
      );
    }
  }

  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = value ?? new Uint8Array(0);
    total += chunk.length;
    if (total > maxBytes) {
      throw new AtIngressHttpError(
        `Response exceeded byte limit of ${maxBytes}`,
        { retryable: false, code: "BODY_TOO_LARGE" },
      );
    }
    chunks.push(chunk);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function normalizeHttpError(error: unknown, url: string): AtIngressHttpError {
  if (error instanceof AtIngressHttpError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new AtIngressHttpError(
      `Request timed out while requesting ${redactUrl(url)}`,
      { retryable: true, code: "TIMEOUT", cause: error },
    );
  }

  if (error instanceof Error) {
    const causeCode = (error.cause as { code?: string } | null)?.code ?? "";
    if (
      causeCode.startsWith("ERR_TLS") ||
      causeCode.startsWith("ERR_SSL") ||
      causeCode === "CERT_HAS_EXPIRED" ||
      causeCode === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      causeCode === "SELF_SIGNED_CERT_IN_CHAIN"
    ) {
      return new AtIngressHttpError(
        `TLS error while requesting ${redactUrl(url)}`,
        { retryable: false, code: "TLS_ERROR", cause: error },
      );
    }
    const retryable = error.name === "TypeError";
    return new AtIngressHttpError(
      `${retryable ? "Network error" : "Request failed"} while requesting ${redactUrl(url)}`,
      { retryable, code: retryable ? "NETWORK_ERROR" : "REQUEST_FAILED", cause: error },
    );
  }

  return new AtIngressHttpError(
    `Unknown request failure while requesting ${redactUrl(url)}`,
    { retryable: false, code: "UNKNOWN", cause: error },
  );
}

function fullJitterBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const capped = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * capped);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return input;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
