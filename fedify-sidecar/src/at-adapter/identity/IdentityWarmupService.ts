import { request } from 'undici';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import {
  applyIdentityProjectionLocally,
  type BackendIdentityChangesResponse,
  type BackendIdentityProjection,
  type RepoRegistryWarmTarget,
} from './IdentityBindingSyncService.js';
import { buildInternalIdentityChangesPath } from './InternalIdentityApi.js';
import { traceIdentitySync, type IdentitySyncLogger } from './IdentitySyncTrace.js';

export interface IdentityWarmCursorStore {
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
}

export interface IdentityWarmupServiceConfig {
  backendBaseUrl: string;
  bearerToken: string;
  identityBindingRepository: IdentityBindingRepository;
  cursorStore: IdentityWarmCursorStore;
  repoRegistry?: RepoRegistryWarmTarget;
  logger?: IdentitySyncLogger;
  intervalMs?: number;
  batchLimit?: number;
  timeoutMs?: number;
  retryAttempts?: number;
  initialRetryDelayMs?: number;
  replayOverlapMs?: number;
}

export class IdentityWarmupService {
  private readonly backendBaseUrl: string;
  private readonly bearerToken: string;
  private readonly identityBindingRepository: IdentityBindingRepository;
  private readonly cursorStore: IdentityWarmCursorStore;
  private readonly repoRegistry?: RepoRegistryWarmTarget;
  private readonly logger?: IdentitySyncLogger;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly replayOverlapMs: number;

  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<{ items: number; nextCursor: string | null }> | null = null;

  constructor(config: IdentityWarmupServiceConfig) {
    this.backendBaseUrl = config.backendBaseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
    this.identityBindingRepository = config.identityBindingRepository;
    this.cursorStore = config.cursorStore;
    this.repoRegistry = config.repoRegistry;
    this.logger = config.logger;
    this.intervalMs = clampNumber(config.intervalMs ?? 30_000, 1_000, 300_000);
    this.batchLimit = clampNumber(config.batchLimit ?? 100, 1, 500);
    this.timeoutMs = clampNumber(config.timeoutMs ?? 10_000, 1_000, 60_000);
    this.retryAttempts = clampNumber(config.retryAttempts ?? 3, 1, 6);
    this.initialRetryDelayMs = clampNumber(config.initialRetryDelayMs ?? 500, 100, 10_000);
    this.replayOverlapMs = clampNumber(
      config.replayOverlapMs ?? Math.max((config.intervalMs ?? 30_000) * 2, 15_000),
      0,
      300_000
    );
  }

  start(): void {
    if (this.started) return;

    this.started = true;
    this.scheduleNextPoll(0);

    traceIdentitySync(this.logger, 'info', 'warmup:started', {
      intervalMs: this.intervalMs,
      batchLimit: this.batchLimit,
      replayOverlapMs: this.replayOverlapMs,
    });
  }

  async stop(): Promise<void> {
    this.started = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // The failure was already logged during the scheduled poll.
      } finally {
        this.inFlight = null;
      }
    }

    traceIdentitySync(this.logger, 'info', 'warmup:stopped');
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.started) return;

    this.timer = setTimeout(() => {
      void this.runScheduledPoll();
    }, delayMs);

    this.timer.unref?.();
  }

  private async runScheduledPoll(): Promise<void> {
    this.inFlight = this.pollOnce();

    try {
      await this.inFlight;
    } catch (error) {
      traceIdentitySync(this.logger, 'warn', 'warmup:poll-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = null;
      this.scheduleNextPoll(this.intervalMs);
    }
  }

  async pollOnce(): Promise<{ items: number; nextCursor: string | null }> {
    const storedCursor = sanitizeCursor(await this.cursorStore.getCursor());
    const replayCursor = rewindCursor(storedCursor, this.replayOverlapMs);

    traceIdentitySync(this.logger, 'debug', 'warmup:poll-start', {
      since: storedCursor,
      replayCursor,
      limit: this.batchLimit,
    });

    const response = await this.fetchChangesWithRetry(replayCursor);

    for (const item of response.items) {
      await applyIdentityProjectionLocally(
        item,
        {
          identityBindingRepository: this.identityBindingRepository,
          repoRegistry: this.repoRegistry,
          logger: this.logger,
        },
        {
          syncType: 'warmup',
          canonicalAccountId: item.canonicalAccountId,
          did: item.atprotoDid,
          handle: item.atprotoHandle,
        }
      );
    }

    const nextCursor = sanitizeCursor(
      response.nextCursor ??
        response.items[response.items.length - 1]?.updatedAt ??
        storedCursor
    );

    const cursorToPersist = selectNewestCursor(storedCursor, nextCursor);

    if (cursorToPersist && cursorToPersist !== storedCursor) {
      await this.cursorStore.setCursor(cursorToPersist);
    }

    traceIdentitySync(this.logger, 'info', 'warmup:poll-success', {
      since: storedCursor,
      replayCursor,
      nextCursor: cursorToPersist,
      items: response.items.length,
    });

    return {
      items: response.items.length,
      nextCursor: cursorToPersist,
    };
  }

  private async fetchChangesWithRetry(
    since: string | null
  ): Promise<BackendIdentityChangesResponse> {
    let lastError: unknown;
    let delayMs = this.initialRetryDelayMs;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.fetchChanges(since);
      } catch (error) {
        lastError = error;
        if (!isRetryableFetchError(error) || attempt === this.retryAttempts) {
          throw error;
        }

        const backoffMs = withJitter(delayMs);
        traceIdentitySync(this.logger, 'warn', 'warmup:retrying', {
          attempt,
          backoffMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(backoffMs);
        delayMs = Math.min(delayMs * 2, this.intervalMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Identity warmup failed');
  }

  private async fetchChanges(since: string | null): Promise<BackendIdentityChangesResponse> {
    const path = buildInternalIdentityChangesPath({
      since,
      limit: this.batchLimit,
    });
    const res = await request(`${this.backendBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
      },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = truncateForError(await res.body.text());
      throw createFetchError(res.statusCode, body);
    }

    const payload = (await res.body.json()) as Partial<BackendIdentityChangesResponse>;
    const items = Array.isArray(payload.items) ? payload.items : [];

    for (const item of items) {
      if (!isBackendIdentityProjection(item as BackendIdentityProjection)) {
        throw new Error('Identity warmup received invalid projection payload');
      }
    }

    return {
      items: items as BackendIdentityProjection[],
      nextCursor: sanitizeCursor(payload.nextCursor ?? null),
    };
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function sanitizeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  const value = cursor.trim();
  if (!value) return null;
  return value.slice(0, 256);
}

function rewindCursor(cursor: string | null, overlapMs: number): string | null {
  if (!cursor || overlapMs <= 0) return cursor;

  const parsed = parseCursor(cursor);
  if (!parsed) return cursor;

  const updatedAtMs = Date.parse(parsed.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return cursor;

  const rewoundUpdatedAt = new Date(Math.max(0, updatedAtMs - overlapMs)).toISOString();
  return encodeCursor({
    updatedAt: rewoundUpdatedAt,
    canonicalAccountId: '\u0000',
  });
}

function selectNewestCursor(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;

  const currentParsed = parseCursor(current);
  const candidateParsed = parseCursor(candidate);

  if (!currentParsed || !candidateParsed) {
    return candidate;
  }

  const updatedAtCompare = candidateParsed.updatedAt.localeCompare(currentParsed.updatedAt);
  if (updatedAtCompare > 0) return candidate;
  if (updatedAtCompare < 0) return current;

  return candidateParsed.canonicalAccountId.localeCompare(currentParsed.canonicalAccountId) > 0
    ? candidate
    : current;
}

function parseCursor(
  cursor: string
): { updatedAt: string; canonicalAccountId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      updatedAt?: unknown;
      canonicalAccountId?: unknown;
    };

    if (
      typeof parsed.updatedAt !== 'string' ||
      parsed.updatedAt.length === 0 ||
      typeof parsed.canonicalAccountId !== 'string' ||
      parsed.canonicalAccountId.length === 0
    ) {
      return null;
    }

    return {
      updatedAt: parsed.updatedAt,
      canonicalAccountId: parsed.canonicalAccountId,
    };
  } catch {
    return null;
  }
}

function encodeCursor(cursor: { updatedAt: string; canonicalAccountId: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function createFetchError(statusCode: number, body: string) {
  const error = new Error(`Identity warmup failed (${statusCode}): ${body}`);
  return Object.assign(error, { statusCode });
}

function isBackendIdentityProjection(
  payload: BackendIdentityProjection | null | undefined
): payload is BackendIdentityProjection {
  const isExternal =
    payload?.atprotoSource === 'external' || payload?.atprotoManaged === false;
  const hasLocalKeyRefs = Boolean(payload?.atSigningKeyRef && payload?.atRotationKeyRef);

  return !!(
    payload &&
    payload.canonicalAccountId &&
    payload.webId &&
    payload.atprotoDid &&
    payload.atprotoHandle &&
    payload.status &&
    ((isExternal && payload.atprotoPdsUrl) || hasLocalKeyRefs)
  );
}

function isRetryableFetchError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { statusCode?: number; code?: string; name?: string };
  const statusCode = candidate.statusCode ?? 0;

  return (
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500 ||
    candidate.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    candidate.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    candidate.code === 'UND_ERR_BODY_TIMEOUT' ||
    candidate.name === 'AbortError'
  );
}

function truncateForError(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 400) return trimmed;
  return `${trimmed.slice(0, 397)}...`;
}

function withJitter(delayMs: number): number {
  const jitter = Math.round(delayMs * 0.2 * Math.random());
  return delayMs + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
