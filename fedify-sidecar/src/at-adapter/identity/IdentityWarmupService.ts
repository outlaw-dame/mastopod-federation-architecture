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

export interface IdentityWarmReplayState {
  /** Current page cursor. Null means the true start-of-stream boundary. */
  cursor: string | null;
  /** High-water boundary this replay obligation must cover. */
  targetCursor: string;
  /** Durable beginning of the covered interval. Null means start-of-stream. */
  baseCursor?: string | null;
  /** Wall-clock horizon through which completed passes must be repeated. */
  settleUntilMs?: number;
}

export interface IdentityWarmCursorStore {
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  getReplayState(): Promise<IdentityWarmReplayState | null>;
  setReplayState(state: IdentityWarmReplayState): Promise<void>;
  clearReplayState(): Promise<void>;
  setCursorAndReplay?(cursor: string, state: IdentityWarmReplayState): Promise<void>;
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
  /** Test seam for deterministic replay-settle horizon checks. */
  now?: () => number;
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
  private readonly now: () => number;

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
    this.now = config.now ?? Date.now;
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
    let replayState = sanitizeReplayState(
      await this.cursorStore.getReplayState(),
      this.replayOverlapMs,
      this.now()
    );

    traceIdentitySync(this.logger, 'debug', 'warmup:poll-start', {
      since: storedCursor,
      replayCursor: replayState?.cursor ?? null,
      replayBaseCursor: replayState?.baseCursor ?? null,
      replayTargetCursor: replayState?.targetCursor ?? null,
      replaySettleUntilMs: replayState?.settleUntilMs ?? null,
      limit: this.batchLimit,
    });

    // The durable high-water mark is always read first. Dense overlap repair
    // can never prevent the warmer from observing records newer than the last
    // committed forward cursor.
    const forwardResponse = await this.fetchChangesWithRetry(storedCursor);
    await this.applyItems(forwardResponse.items);

    const forwardNextCursor = sanitizeCursor(
      forwardResponse.nextCursor ??
        forwardResponse.items[forwardResponse.items.length - 1]?.updatedAt ??
        storedCursor
    );
    const cursorToPersist = selectNewestCursor(storedCursor, forwardNextCursor);
    const forwardSaturated = forwardResponse.items.length >= this.batchLimit;
    const cursorAdvanced = Boolean(cursorToPersist && cursorToPersist !== storedCursor);

    let replayToPersist: IdentityWarmReplayState | null = null;
    if (this.replayOverlapMs > 0 && cursorToPersist) {
      if (replayState) {
        const extendedTarget = selectNewestCursor(replayState.targetCursor, cursorToPersist);
        if (extendedTarget && extendedTarget !== replayState.targetCursor) {
          replayToPersist = {
            ...replayState,
            targetCursor: extendedTarget,
            // A newly extended interval may receive delayed visibility relative
            // to processing time even when its record timestamps are old. Extend
            // the wall-clock settle horizon whenever coverage grows.
            settleUntilMs: this.now() + this.replayOverlapMs,
          };
        }
      } else if (cursorAdvanced || !forwardSaturated) {
        // A missing stored cursor is a real start-of-stream boundary, not the
        // ending cursor of the first page. Persist null as the replay base so a
        // saturated bootstrap page cannot permanently omit its early portion.
        const baseCursor = storedCursor
          ? rewindCursor(storedCursor, this.replayOverlapMs)
          : null;
        if (baseCursor !== cursorToPersist) {
          replayToPersist = {
            cursor: baseCursor,
            baseCursor,
            targetCursor: cursorToPersist,
            settleUntilMs: this.now() + this.replayOverlapMs,
          };
        }
      }
    }

    if (replayToPersist && cursorAdvanced && this.cursorStore.setCursorAndReplay) {
      await this.cursorStore.setCursorAndReplay(cursorToPersist!, replayToPersist);
      replayState = replayToPersist;
    } else {
      if (replayToPersist) {
        // Safe fallback for alternate stores: persist/extend the replay
        // obligation before the high-water cursor. A crash may repeat work, but
        // it cannot truncate coverage.
        await this.cursorStore.setReplayState(replayToPersist);
        replayState = replayToPersist;
      }
      if (cursorAdvanced) {
        await this.cursorStore.setCursor(cursorToPersist!);
      }
    }

    let replayItems = 0;

    // Saturated forward catch-up gets the entire request/upsert budget. Replay
    // execution is paused, but its durable target/horizon has already been
    // extended above so no crossed interval is forgotten.
    if (!forwardSaturated && replayState) {
      const requestedReplayCursor = replayState.cursor ?? null;
      const replayPassStartedAtOrAfterHorizon =
        requestedReplayCursor === (replayState.baseCursor ?? null) &&
        this.now() >= (replayState.settleUntilMs ?? 0);
      const replayResponse = await this.fetchChangesWithRetry(requestedReplayCursor);
      await this.applyItems(replayResponse.items);
      replayItems = replayResponse.items.length;

      const replayNextCursor = sanitizeCursor(
        replayResponse.nextCursor ??
          replayResponse.items[replayResponse.items.length - 1]?.updatedAt ??
          requestedReplayCursor
      );

      const replayPassComplete =
        replayResponse.items.length === 0 ||
        !replayNextCursor ||
        replayNextCursor === requestedReplayCursor ||
        isCursorAtOrAfter(replayNextCursor, replayState.targetCursor);

      if (replayPassComplete) {
        if (replayPassStartedAtOrAfterHorizon) {
          // Clearing is allowed only after an entire pass began from the durable
          // base after the lateness horizon. A pass that merely finished after
          // the horizon may have traversed its early pages too soon.
          await this.cursorStore.clearReplayState();
          replayState = null;
        } else {
          // Do not discard the sole pointer capable of seeing a late-visible
          // record behind the current page cursor. Rewind to the durable base
          // and repeat the covered interval on later caught-up polls.
          replayState = {
            ...replayState,
            cursor: replayState.baseCursor ?? null,
          };
          await this.cursorStore.setReplayState(replayState);
        }
      } else {
        // Apply first, then durably advance only this pass's progress. The base
        // remains unchanged so a later full re-sweep can revisit older pages.
        replayState = {
          ...replayState,
          cursor: replayNextCursor,
        };
        await this.cursorStore.setReplayState(replayState);
      }
    }

    traceIdentitySync(this.logger, 'info', 'warmup:poll-success', {
      since: storedCursor,
      nextCursor: cursorToPersist,
      forwardItems: forwardResponse.items.length,
      replayItems,
      replayPausedForForwardBacklog: forwardSaturated && Boolean(replayState),
      replayCursor: replayState?.cursor ?? null,
      replayBaseCursor: replayState?.baseCursor ?? null,
      replayTargetCursor: replayState?.targetCursor ?? null,
      replaySettleUntilMs: replayState?.settleUntilMs ?? null,
    });

    return {
      items: forwardResponse.items.length + replayItems,
      nextCursor: cursorToPersist,
    };
  }

  private async applyItems(items: BackendIdentityProjection[]): Promise<void> {
    for (const item of items) {
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

function sanitizeReplayState(
  state: IdentityWarmReplayState | null | undefined,
  replayOverlapMs: number,
  nowMs: number
): IdentityWarmReplayState | null {
  if (!state) return null;
  const targetCursor = sanitizeCursor(state.targetCursor);
  if (!targetCursor) return null;

  const cursor = state.cursor === null ? null : sanitizeCursor(state.cursor);
  if (state.cursor !== null && !cursor) return null;

  const hasBaseCursor = Object.prototype.hasOwnProperty.call(state, 'baseCursor');
  const baseCursor = hasBaseCursor
    ? state.baseCursor === null
      ? null
      : sanitizeCursor(state.baseCursor)
    : cursor;
  if (hasBaseCursor && state.baseCursor !== null && !baseCursor) return null;

  const settleUntilMs =
    typeof state.settleUntilMs === 'number' && Number.isFinite(state.settleUntilMs)
      ? Math.max(0, Math.trunc(state.settleUntilMs))
      : nowMs + replayOverlapMs;

  return {
    cursor,
    baseCursor,
    targetCursor,
    settleUntilMs,
  };
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

function isCursorAtOrAfter(candidate: string, target: string): boolean {
  return selectNewestCursor(target, candidate) === candidate;
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
