import { randomInt } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { OAuthError } from './OAuthErrors.js';

function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number.parseInt(ip.split('.')[1] ?? '-1', 10);
    if (second >= 16 && second <= 31) return true;
  }

  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) {
    return true;
  }

  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export async function assertSafeTarget(url: URL, allowLocalhostHttp = false): Promise<void> {
  if (url.username || url.password) {
    throw new OAuthError('invalid_request', 400, 'URL credentials are not allowed');
  }

  if (url.protocol === 'https:') {
    // allowed
  } else if (url.protocol === 'http:' && allowLocalhostHttp && isLoopbackHostname(url.hostname)) {
    // allowed for localhost dev only
   } else {
     throw new OAuthError('invalid_request', 400, 'Only HTTPS targets are allowed');
   }

  const hostname = url.hostname.trim();
  const ipType = isIP(hostname);

  if (ipType !== 0) {
    if (isPrivateIp(hostname) && !(allowLocalhostHttp && isLoopbackHostname(hostname))) {
      throw new OAuthError('invalid_request', 400, 'Private network targets are not allowed');
    }
    return;
  }

  const records = await lookup(hostname, { all: true });
  if (!records.length) {
    throw new OAuthError('temporarily_unavailable', 503, 'Host resolution failed');
  }

  for (const record of records) {
    if (isPrivateIp(record.address) && !(allowLocalhostHttp && isLoopbackHostname(hostname))) {
      throw new OAuthError('invalid_request', 400, 'Resolved private network target is not allowed');
    }
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /abort|timed out|fetch failed|network|socket|econnreset|econnrefused|eai_again|enotfound/i.test(message);
}

function backoffWithFullJitter(attempt: number, baseMs: number, capMs: number): number {
  const upper = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return randomInt(0, Math.max(1, upper + 1));
}

export interface SafeJsonRequestOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  headers?: Record<string, string>;
}

export async function fetchJsonWithRetry(
  url: URL,
  options: SafeJsonRequestOptions,
): Promise<Record<string, unknown>> {
  const baseDelayMs = options.baseDelayMs ?? 200;
  const capDelayMs = options.capDelayMs ?? 5_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < options.maxAttempts) {
          await sleep(backoffWithFullJitter(attempt, baseDelayMs, capDelayMs));
          continue;
        }
        throw new OAuthError('temporarily_unavailable', 503, `Upstream request failed with status ${res.status}`);
      }

      const data = await res.json() as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new OAuthError('invalid_request', 400, 'Upstream response JSON object is invalid');
      }
      return data as Record<string, unknown>;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (error instanceof OAuthError) {
        throw error;
      }
      if (isRetryableNetworkError(error) && attempt < options.maxAttempts) {
        await sleep(backoffWithFullJitter(attempt, baseDelayMs, capDelayMs));
        continue;
      }
      throw new OAuthError('temporarily_unavailable', 503, 'Upstream request failed');
    }
  }

  throw lastError instanceof OAuthError
    ? lastError
    : new OAuthError('temporarily_unavailable', 503, 'Upstream request failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
