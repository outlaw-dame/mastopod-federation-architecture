import { request } from 'undici';
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository.js';
import {
  backendIdentityProjectionToBinding,
  type BackendIdentityProjection,
  type RepoRegistryBootstrapAdapter,
  warmRepoRegistryFromProjection,
} from './IdentityBindingSyncService.js';
import { buildInternalIdentityChangesPath } from './InternalIdentityApi.js';
import { traceIdentitySync, type IdentitySyncLogger } from './IdentitySyncTrace.js';

export interface IdentityWarmCursorStore {
  getCursor(): Promise<string | null>;
  setCursor(cursor: string | null): Promise<void>;
}

export interface BackendIdentityChangesPayload {
  items?: BackendIdentityProjection[];
  nextCursor?: string | null;
}

export interface PollingIdentityWarmupServiceConfig {
  backendBaseUrl: string;
  bearerToken: string;
  identityBindingRepository: IdentityBindingRepository;
  cursorStore: IdentityWarmCursorStore;
  repoRegistry?: RepoRegistryBootstrapAdapter;
  logger?: IdentitySyncLogger;
  intervalMs?: number;
  batchLimit?: number;
  timeoutMs?: number;
}

export interface IdentityWarmupRunReport {
  cursorBefore: string | null;
  fetched: number;
  upserted: number;
  nextCursor: string | null;
}

export class PollingIdentityWarmupService {
  private readonly backendBaseUrl: string;
  private readonly bearerToken: string;
  private readonly identityBindingRepository: IdentityBindingRepository;
  private readonly cursorStore: IdentityWarmCursorStore;
  private readonly repoRegistry?: RepoRegistryBootstrapAdapter;
  private readonly logger?: IdentitySyncLogger;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly timeoutMs: number;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<IdentityWarmupRunReport> | null = null;
  private started = false;
  private stopped = false;

  constructor(config: PollingIdentityWarmupServiceConfig) {
    this.backendBaseUrl = config.backendBaseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
    this.identityBindingRepository = config.identityBindingRepository;
    this.cursorStore = config.cursorStore;
    this.repoRegistry = config.repoRegistry;
    this.logger = config.logger;
    this.intervalMs = config.intervalMs ?? 30_000;
    this.batchLimit = config.batchLimit ?? 100;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  start(): void {
    if (this.started) return;

    this.started = true;
    this.stopped = false;

    traceIdentitySync(this.logger, 'info', 'warmup:start', {
      intervalMs: this.intervalMs,
      batchLimit: this.batchLimit,
    });

    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // Shutdown should not fail because the last poll attempt failed.
      }
    }

    traceIdentitySync(this.logger, 'info', 'warmup:stop');
  }

  async runOnce(): Promise<IdentityWarmupRunReport> {
    if (this.inFlight) {
      return this.inFlight;
    }

    return this.runPollCycle();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.pollInBackground();
    }, delayMs);
  }

  private async pollInBackground(): Promise<void> {
    if (this.stopped || this.inFlight) return;

    this.inFlight = this.runPollCycle()
      .then((report) => {
        traceIdentitySync(this.logger, 'debug', 'warmup:cycle-complete', {
          ...report,
        });
        const caughtUp = report.fetched < this.batchLimit;
        this.schedule(caughtUp ? this.intervalMs : 0);
        return report;
      })
      .catch((error) => {
        traceIdentitySync(this.logger, 'warn', 'warmup:cycle-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.schedule(this.intervalMs);
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    try {
      await this.inFlight;
    } catch {
      // The caller is the background loop; errors are already traced above.
    }
  }

  private async runPollCycle(): Promise<IdentityWarmupRunReport> {
    const cursorBefore = await this.cursorStore.getCursor();
    const path = buildInternalIdentityChangesPath({
      since: cursorBefore,
      limit: this.batchLimit,
    });

    traceIdentitySync(this.logger, 'debug', 'warmup:fetch-start', {
      cursorBefore,
      path,
      batchLimit: this.batchLimit,
    });

    const res = await request(`${this.backendBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
      },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });

    if (res.statusCode === 404) {
      traceIdentitySync(this.logger, 'warn', 'warmup:changes-feed-not-found', {
        path,
        status: res.statusCode,
      });

      return {
        cursorBefore,
        fetched: 0,
        upserted: 0,
        nextCursor: cursorBefore,
      };
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      traceIdentitySync(this.logger, 'warn', 'warmup:fetch-failed', {
        path,
        status: res.statusCode,
        body,
      });
      throw new Error(`Identity warmup failed (${res.statusCode}): ${body}`);
    }

    const payload = (await res.body.json()) as BackendIdentityChangesPayload | null;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const nextCursor =
      typeof payload?.nextCursor === 'string' || payload?.nextCursor === null
        ? payload.nextCursor
        : cursorBefore;

    let upserted = 0;

    for (const projection of items) {
      await this.identityBindingRepository.upsert(
        backendIdentityProjectionToBinding(projection)
      );
      await warmRepoRegistryFromProjection({
        projection,
        repoRegistry: this.repoRegistry,
        logger: this.logger,
        meta: {
          syncType: 'warmup',
          canonicalAccountId: projection.canonicalAccountId,
          did: projection.atprotoDid,
          handle: projection.atprotoHandle,
        },
      });
      upserted += 1;
    }

    if (typeof nextCursor !== 'undefined') {
      await this.cursorStore.setCursor(nextCursor);
    }

    traceIdentitySync(this.logger, 'info', 'warmup:upsert-success', {
      fetched: items.length,
      upserted,
      nextCursor,
    });

    return {
      cursorBefore,
      fetched: items.length,
      upserted,
      nextCursor: nextCursor ?? null,
    };
  }
}
