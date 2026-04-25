import pLimit from "p-limit";
import {
  HydrationResultSchema,
  HydrationRequestSchema,
  type FeedSource,
  type HydrationItemInput,
  type HydrationOmittedReason,
  type HydrationRequest,
  type HydrationResult,
} from "./contracts.js";

export class PodHydrationServiceError extends Error {
  public readonly retryable: boolean;

  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "PodHydrationServiceError";
    this.retryable = options?.retryable ?? false;
  }
}

export interface HydrationSourceRequest {
  request: HydrationRequest;
  items: HydrationItemInput[];
}

export interface PodHydrator {
  hydrate(input: HydrationSourceRequest): Promise<HydrationResult>;
}

export interface PodHydrationServiceOptions {
  concurrency?: number;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  return Boolean(typeof error === "object" && error && "retryable" in error && (error as any).retryable);
}

function itemKey(item: HydrationItemInput): string {
  return item.stableId ?? item.canonicalUri ?? item.activityPubObjectId ?? JSON.stringify(item);
}

export class DefaultPodHydrationService {
  private readonly limit;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly hydrators: ReadonlyMap<FeedSource | "default", PodHydrator>,
    options: PodHydrationServiceOptions = {},
  ) {
    this.limit = pLimit(options.concurrency ?? 4);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2_000;
  }

  public async hydrate(input: HydrationRequest): Promise<HydrationResult> {
    const request = HydrationRequestSchema.parse(input);
    const uniqueItems = dedupeItems(request.items);
    const grouped = groupBySource(uniqueItems);

    const jobs = [...grouped.entries()].map(([source, items]) =>
      this.limit(async () => this.hydrateGroup(source, { ...request, items })),
    );

    const results = await Promise.all(jobs);
    const merged = mergeHydrationResults(results);
    return HydrationResultSchema.parse(merged);
  }

  private async hydrateGroup(source: FeedSource | "default", request: HydrationRequest): Promise<HydrationResult> {
    const hydrator = this.hydrators.get(source) ?? this.hydrators.get("default");
    if (!hydrator) {
      return {
        items: [],
        omitted: request.items.map((item) => ({
          id: itemKey(item),
          reason: "unsupported_source" satisfies HydrationOmittedReason,
        })),
      };
    }

    try {
      return await this.withRetry(() => hydrator.hydrate({ request, items: request.items }));
    } catch {
      return {
        items: [],
        omitted: request.items.map((item) => ({
          id: itemKey(item),
          reason: "temporarily_unavailable" satisfies HydrationOmittedReason,
        })),
      };
    }
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let delayMs = this.initialDelayMs;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        if (attempt >= this.maxAttempts || !isRetryableError(error)) {
          throw error;
        }
        const jitter = 1 + (Math.random() * 0.4 - 0.2);
        await sleep(Math.min(delayMs * jitter, this.maxDelayMs));
        delayMs = Math.min(delayMs * 2, this.maxDelayMs);
      }
    }
  }
}

function dedupeItems(items: HydrationRequest["items"]): HydrationRequest["items"] {
  const seen = new Set<string>();
  const deduped: HydrationRequest["items"] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function groupBySource(items: HydrationRequest["items"]): Map<FeedSource | "default", HydrationRequest["items"]> {
  const grouped = new Map<FeedSource | "default", HydrationRequest["items"]>();
  for (const item of items) {
    const key = item.source ?? "default";
    const existing = grouped.get(key) ?? [];
    existing.push(item);
    grouped.set(key, existing);
  }
  return grouped;
}

function mergeHydrationResults(results: HydrationResult[]): HydrationResult {
  const items = results.flatMap((result) => result.items);
  const omitted = results.flatMap((result) => result.omitted ?? []);
  return omitted.length > 0 ? { items, omitted } : { items };
}
