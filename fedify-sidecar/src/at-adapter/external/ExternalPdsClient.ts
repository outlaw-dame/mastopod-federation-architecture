import { randomInt } from 'node:crypto';

export interface ExternalPdsSessionResponse {
  did: string;
  handle?: string;
  accessJwt: string;
  refreshJwt?: string;
}

export interface ExternalPdsResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

interface ExternalPdsClientConfig {
  timeoutMs?: number;
  maxAttempts?: number;
}

interface RequestJsonOptions extends RequestInit {
  allowRetryOnAuthFailure?: boolean;
}

export class ExternalPdsClientError extends Error {
  readonly status?: number;
  readonly error?: string;
  readonly retryable: boolean;
  readonly sanitizedBody?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      error?: string;
      retryable?: boolean;
      sanitizedBody?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'ExternalPdsClientError';
    this.status = options.status;
    this.error = options.error;
    this.retryable = options.retryable ?? false;
    this.sanitizedBody = options.sanitizedBody;
  }
}

export class ExternalPdsClient {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(config: ExternalPdsClientConfig = {}) {
    this.timeoutMs = clampInteger(config.timeoutMs ?? 8_000, 1_000, 30_000);
    this.maxAttempts = clampInteger(config.maxAttempts ?? 5, 1, 8);
  }

  async createSession(
    pdsUrl: string,
    identifier: string,
    password: string
  ): Promise<ExternalPdsSessionResponse> {
    const response = await this.requestJson<ExternalPdsSessionResponse>(
      pdsUrl,
      '/xrpc/com.atproto.server.createSession',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          identifier: sanitizeIdentifier(identifier),
          password,
        }),
      }
    );

    return response.body;
  }

  async refreshSession(
    pdsUrl: string,
    refreshJwt: string
  ): Promise<ExternalPdsSessionResponse> {
    const response = await this.requestJson<ExternalPdsSessionResponse>(
      pdsUrl,
      '/xrpc/com.atproto.server.refreshSession',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${refreshJwt}`,
        },
        allowRetryOnAuthFailure: false,
      }
    );

    return response.body;
  }

  async createRecord(
    pdsUrl: string,
    accessJwt: string,
    body: unknown
  ): Promise<ExternalPdsResponse<unknown>> {
    return this.requestJson(
      pdsUrl,
      '/xrpc/com.atproto.repo.createRecord',
      withBearerJson(accessJwt, body)
    );
  }

  async putRecord(
    pdsUrl: string,
    accessJwt: string,
    body: unknown
  ): Promise<ExternalPdsResponse<unknown>> {
    return this.requestJson(
      pdsUrl,
      '/xrpc/com.atproto.repo.putRecord',
      withBearerJson(accessJwt, body)
    );
  }

  async deleteRecord(
    pdsUrl: string,
    accessJwt: string,
    body: unknown
  ): Promise<ExternalPdsResponse<unknown>> {
    return this.requestJson(
      pdsUrl,
      '/xrpc/com.atproto.repo.deleteRecord',
      withBearerJson(accessJwt, body)
    );
  }

  async getRecord(
    pdsUrl: string,
    repo: string,
    collection: string,
    rkey: string,
    cid?: string
  ): Promise<ExternalPdsResponse<unknown>> {
    const query = new URLSearchParams({
      repo: sanitizeRepoParam(repo),
      collection: collection.trim(),
      rkey: rkey.trim(),
    });
    if (cid?.trim()) {
      query.set('cid', cid.trim());
    }

    return this.requestJson(
      pdsUrl,
      `/xrpc/com.atproto.repo.getRecord?${query.toString()}`,
      { method: 'GET' }
    );
  }

  async getLatestCommit(
    pdsUrl: string,
    did: string
  ): Promise<ExternalPdsResponse<unknown>> {
    const query = new URLSearchParams({
      did: did.trim(),
    });

    return this.requestJson(
      pdsUrl,
      `/xrpc/com.atproto.sync.getLatestCommit?${query.toString()}`,
      { method: 'GET' }
    );
  }

  async getRepo(
    pdsUrl: string,
    did: string,
    since?: string
  ): Promise<ExternalPdsResponse<Uint8Array>> {
    const query = new URLSearchParams({
      did: sanitizeRepoParam(did),
    });

    if (since?.trim()) {
      query.set('since', sanitizeRevision(since));
    }

    return this.requestBytes(
      pdsUrl,
      `/xrpc/com.atproto.sync.getRepo?${query.toString()}`,
      { method: 'GET' }
    );
  }

  async listRecords(
    pdsUrl: string,
    query: {
      repo: string;
      collection: string;
      limit?: number;
      cursor?: string;
      reverse?: boolean;
    }
  ): Promise<ExternalPdsResponse<unknown>> {
    const params = new URLSearchParams({
      repo: sanitizeRepoParam(query.repo),
      collection: query.collection.trim(),
    });

    if (typeof query.limit === 'number' && Number.isInteger(query.limit) && query.limit > 0) {
      params.set('limit', String(query.limit));
    }
    if (query.cursor?.trim()) {
      params.set('cursor', query.cursor.trim());
    }
    if (query.reverse === true) {
      params.set('reverse', 'true');
    }

    return this.requestJson(
      pdsUrl,
      `/xrpc/com.atproto.repo.listRecords?${params.toString()}`,
      { method: 'GET' }
    );
  }

  async describeRepo(
    pdsUrl: string,
    repo: string
  ): Promise<ExternalPdsResponse<unknown>> {
    const params = new URLSearchParams({
      repo: sanitizeRepoParam(repo),
    });

    return this.requestJson(
      pdsUrl,
      `/xrpc/com.atproto.repo.describeRepo?${params.toString()}`,
      { method: 'GET' }
    );
  }

  private async requestJson<T>(
    pdsUrl: string,
    pathWithQuery: string,
    init: RequestJsonOptions
  ): Promise<ExternalPdsResponse<T>> {
    return this.request(
      pdsUrl,
      pathWithQuery,
      init,
      async (response) => (await response.json()) as T
    );
  }

  private async requestBytes(
    pdsUrl: string,
    pathWithQuery: string,
    init: RequestJsonOptions
  ): Promise<ExternalPdsResponse<Uint8Array>> {
    return this.request(
      pdsUrl,
      pathWithQuery,
      init,
      async (response) => new Uint8Array(await response.arrayBuffer())
    );
  }

  private async request<T>(
    pdsUrl: string,
    pathWithQuery: string,
    init: RequestJsonOptions,
    parseSuccess: (response: Response) => Promise<T>
  ): Promise<ExternalPdsResponse<T>> {
    const origin = normalizePdsOrigin(pdsUrl);
    const url = new URL(pathWithQuery, origin).toString();
    let lastError: ExternalPdsClientError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          return {
            status: response.status,
            headers: response.headers,
            body: await parseSuccess(response),
          };
        }

        const parsed = await parseErrorResponse(response);
        const error = new ExternalPdsClientError(
          parsed.message ?? `External PDS request failed (${response.status})`,
          {
            status: response.status,
            error: parsed.error,
            retryable:
              response.status === 408 ||
              response.status === 425 ||
              response.status === 429 ||
              response.status === 500 ||
              response.status === 502 ||
              response.status === 503 ||
              response.status === 504,
            sanitizedBody: parsed.sanitizedBody,
          }
        );

        lastError = error;

        if (
          error.retryable &&
          attempt < this.maxAttempts &&
          !(response.status === 401 || response.status === 403) &&
          init.allowRetryOnAuthFailure !== false
        ) {
          await sleep(computeBackoffDelay(attempt, response.headers.get('retry-after')));
          continue;
        }

        throw error;
      } catch (error) {
        clearTimeout(timeout);

        if (error instanceof ExternalPdsClientError) {
          throw error;
        }

        const retryable = isRetryableTransportError(error);
        lastError = new ExternalPdsClientError(
          'External PDS request failed',
          {
            retryable,
            cause: error,
          }
        );

        if (retryable && attempt < this.maxAttempts) {
          await sleep(computeBackoffDelay(attempt));
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new ExternalPdsClientError('External PDS request failed');
  }
}

export function normalizePdsOrigin(pdsUrl: string): string {
  const trimmed = pdsUrl.trim();
  if (!trimmed) {
    throw new ExternalPdsClientError('External PDS URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new ExternalPdsClientError('External PDS URL is invalid', { cause: error });
  }

  if (parsed.username || parsed.password) {
    throw new ExternalPdsClientError('External PDS URL must not include credentials');
  }

  if (parsed.search || parsed.hash) {
    throw new ExternalPdsClientError('External PDS URL must not include query or fragment components');
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new ExternalPdsClientError('External PDS URL must use https unless targeting loopback');
  }

  return parsed.origin;
}

function withBearerJson(accessJwt: string, body: unknown): RequestJsonOptions {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessJwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    allowRetryOnAuthFailure: false,
  };
}

function sanitizeIdentifier(identifier: string): string {
  const sanitized = identifier.trim();
  if (!sanitized || sanitized.length > 2_048) {
    throw new ExternalPdsClientError('External AT identifier is invalid');
  }
  return sanitized;
}

function sanitizeRepoParam(repo: string): string {
  const sanitized = repo.trim();
  if (!sanitized || sanitized.length > 2_048) {
    throw new ExternalPdsClientError('External repo identifier is invalid');
  }
  return sanitized;
}

function sanitizeRevision(revision: string): string {
  const sanitized = revision.trim();
  if (!sanitized || sanitized.length > 512) {
    throw new ExternalPdsClientError('External repo revision is invalid');
  }
  return sanitized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

async function parseErrorResponse(response: Response): Promise<{
  error?: string;
  message?: string;
  sanitizedBody?: string;
}> {
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();

  if (!raw) {
    return {};
  }

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
        sanitizedBody: JSON.stringify(redactSensitive(parsed)).slice(0, 512),
      };
    } catch {
      return {
        sanitizedBody: raw.slice(0, 512),
      };
    }
  }

  return {
    sanitizedBody: raw.slice(0, 512),
  };
}

function redactSensitive(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'accessJwt' || key === 'refreshJwt' || key === 'password') {
      redacted[key] = '[redacted]';
      continue;
    }
    redacted[key] = redactSensitive(entry);
  }
  return redacted;
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort|timed out|fetch failed|network|socket|econnreset|econnrefused|eai_again|enotfound/i.test(message);
}

function computeBackoffDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return Math.min(10_000, retryAfterMs);
    }
  }

  const base = 250;
  const cap = 5_000;
  const max = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return randomInt(0, Math.max(1, max + 1));
}

function parseRetryAfterMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }

  return Math.max(0, dateMs - Date.now());
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
