import type {
  ModerationBridgeStore,
  ModerationCase,
  ModerationCasePage,
  ModerationCaseQuery,
} from "./types.js";

interface CaseStoreClientOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

type CaseStoreHttpResponse<T> = {
  case?: T;
  cases?: T[];
  cursor?: string;
};

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithJitter<T>(
  operation: () => Promise<T>,
  options: { retries: number; baseMs: number; maxMs: number },
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= options.retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = (error as { retryable?: boolean } | null | undefined)?.retryable !== false;
      if (!retryable || attempt === options.retries) {
        break;
      }
      const backoff = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(25, Math.floor(backoff / 2)));
      await sleep(backoff + jitter);
      attempt += 1;
    }
  }

  throw lastError;
}

export class ActivityPodsModerationCaseStore {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: CaseStoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 5_000);
    this.retries = Math.max(0, options.retries ?? 3);
    this.retryBaseMs = Math.max(25, options.retryBaseMs ?? 100);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 2_000);
  }

  async addCase(entry: ModerationCase): Promise<void> {
    await this.requestJson<CaseStoreHttpResponse<ModerationCase>>("/api/internal/moderation/cases", {
      method: "POST",
      body: entry,
    });
  }

  async getCase(id: string): Promise<ModerationCase | null> {
    const payload = await this.requestJson<CaseStoreHttpResponse<ModerationCase>>(
      `/api/internal/moderation/cases/${encodeURIComponent(id)}`,
      { method: "GET" },
      { allowNotFound: true },
    );
    return payload?.case ?? null;
  }

  async findCaseByDedupeKey(dedupeKey: string): Promise<ModerationCase | null> {
    const payload = await this.requestJson<CaseStoreHttpResponse<ModerationCase>>(
      `/api/internal/moderation/cases/by-dedupe/${encodeURIComponent(dedupeKey)}`,
      { method: "GET" },
      { allowNotFound: true },
    );
    return payload?.case ?? null;
  }

  async listCases(query: ModerationCaseQuery = {}): Promise<ModerationCasePage> {
    const payload = await this.requestJson<CaseStoreHttpResponse<ModerationCase>>(
      "/api/internal/moderation/cases",
      {
        method: "GET",
      },
      {
        query: {
          limit: query.limit ? String(query.limit) : undefined,
          cursor: query.cursor,
          status: query.status,
          source: query.source,
          sourceActorUri: query.sourceActorUri,
          recipientWebId: query.recipientWebId,
          reportedActorUri: query.reportedActorUri,
        },
      },
    );

    return {
      cases: Array.isArray(payload?.cases) ? payload.cases : [],
      cursor: payload?.cursor,
    };
  }

  async patchCase(id: string, patch: Partial<ModerationCase>): Promise<ModerationCase | null> {
    const payload = await this.requestJson<CaseStoreHttpResponse<ModerationCase>>(
      `/api/internal/moderation/cases/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: patch,
      },
      { allowNotFound: true },
    );
    return payload?.case ?? null;
  }

  private async requestJson<T>(
    path: string,
    options: { method: "GET" | "POST" | "PATCH"; body?: unknown },
    extras: {
      allowNotFound?: boolean;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<T | null> {
    const execute = async () => {
      const response = await fetch(buildUrl(this.baseUrl, path, extras.query), {
        method: options.method,
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 404 && extras.allowNotFound) {
        return null;
      }

      const text = await response.text();
      const payload = text.length > 0 ? safeParseJson<T>(text) : null;

      if (!response.ok) {
        const message =
          (payload && typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as Record<string, unknown>)["error"])
            : null) ||
          `ActivityPods moderation case API failed (${response.status})`;
        const error = new Error(message) as Error & { retryable?: boolean };
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }

      return payload;
    };

    return retryWithJitter(execute, {
      retries: this.retries,
      baseMs: this.retryBaseMs,
      maxMs: this.retryMaxMs,
    });
  }
}

export class CompositeModerationBridgeStore implements ModerationBridgeStore {
  constructor(
    private readonly baseStore: ModerationBridgeStore,
    private readonly caseStore: ActivityPodsModerationCaseStore,
  ) {}

  addDecision(decision: Parameters<ModerationBridgeStore["addDecision"]>[0]) {
    return this.baseStore.addDecision(decision);
  }

  getDecision(id: Parameters<ModerationBridgeStore["getDecision"]>[0]) {
    return this.baseStore.getDecision(id);
  }

  listDecisions(query?: Parameters<ModerationBridgeStore["listDecisions"]>[0]) {
    return this.baseStore.listDecisions(query);
  }

  patchDecision(id: Parameters<ModerationBridgeStore["patchDecision"]>[0], patch: Parameters<ModerationBridgeStore["patchDecision"]>[1]) {
    return this.baseStore.patchDecision(id, patch);
  }

  addCase(entry: Parameters<ModerationBridgeStore["addCase"]>[0]) {
    return this.caseStore.addCase(entry);
  }

  getCase(id: Parameters<ModerationBridgeStore["getCase"]>[0]) {
    return this.caseStore.getCase(id);
  }

  findCaseByDedupeKey(dedupeKey: Parameters<ModerationBridgeStore["findCaseByDedupeKey"]>[0]) {
    return this.caseStore.findCaseByDedupeKey(dedupeKey);
  }

  listCases(query?: Parameters<ModerationBridgeStore["listCases"]>[0]) {
    return this.caseStore.listCases(query);
  }

  patchCase(id: Parameters<ModerationBridgeStore["patchCase"]>[0], patch: Parameters<ModerationBridgeStore["patchCase"]>[1]) {
    return this.caseStore.patchCase(id, patch);
  }

  addAtLabel(label: Parameters<ModerationBridgeStore["addAtLabel"]>[0]) {
    return this.baseStore.addAtLabel(label);
  }

  listAtLabels(query?: Parameters<ModerationBridgeStore["listAtLabels"]>[0]) {
    return this.baseStore.listAtLabels(query);
  }
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
