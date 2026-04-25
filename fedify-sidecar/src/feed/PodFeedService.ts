import { FeedRegistry } from "./FeedRegistry.js";
import { FeedRequestSchema, FeedResponseSchema, type FeedDefinition, type FeedRequest, type FeedResponse, type FeedSource } from "./contracts.js";

export class PodFeedServiceError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly statusCode: number;

  constructor(message: string, options?: { code?: string; retryable?: boolean; statusCode?: number }) {
    super(message);
    this.name = "PodFeedServiceError";
    this.code = options?.code ?? "POD_FEED_SERVICE_ERROR";
    this.retryable = options?.retryable ?? false;
    this.statusCode = options?.statusCode ?? 500;
  }
}

export interface ResolvedFeedRequest {
  definition: FeedDefinition;
  request: FeedRequest;
}

export interface PodFeedProvider {
  getFeed(input: ResolvedFeedRequest): Promise<FeedResponse>;
}

export interface PodFeedServiceOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const statusCode = typeof error === "object" && error && "statusCode" in error ? Number((error as any).statusCode) : NaN;
  const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : NaN;
  const retryable = typeof error === "object" && error && "retryable" in error ? Boolean((error as any).retryable) : false;
  return retryable || [408, 429, 500, 502, 503, 504].includes(statusCode) || [408, 429, 500, 502, 503, 504].includes(status);
}

function supportsSource(definition: FeedDefinition, source: FeedSource): boolean {
  switch (source) {
    case "stream1":
      return definition.sourcePolicy.includeStream1;
    case "stream2":
      return definition.sourcePolicy.includeStream2;
    case "canonical":
      return definition.sourcePolicy.includeCanonical;
    case "firehose":
      return definition.sourcePolicy.includeFirehose;
    case "unified":
      return definition.sourcePolicy.includeUnified;
  }
}

export class DefaultPodFeedService {
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly registry: FeedRegistry,
    private readonly providers: ReadonlyMap<string, PodFeedProvider>,
    options: PodFeedServiceOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2_000;
  }

  public listFeeds(viewerId?: string) {
    return this.registry.listPublic({ viewerId });
  }

  public async getFeed(input: FeedRequest): Promise<FeedResponse> {
    const request = FeedRequestSchema.parse(input);
    const definition = this.registry.getInternal(request.feedId);
    if (!definition) {
      throw new PodFeedServiceError(`Unknown feed: ${request.feedId}`, {
        code: "UNKNOWN_FEED",
        statusCode: 404,
      });
    }

    if (definition.visibility === "authenticated" && !request.viewerId) {
      throw new PodFeedServiceError(`Feed requires authentication: ${request.feedId}`, {
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401,
      });
    }

    if (definition.visibility === "internal") {
      throw new PodFeedServiceError(`Feed is not externally accessible: ${request.feedId}`, {
        code: "FEED_NOT_PUBLIC",
        statusCode: 403,
      });
    }

    const provider = this.providers.get(definition.providerId);
    if (!provider) {
      throw new PodFeedServiceError(`No provider registered for feed: ${request.feedId}`, {
        code: "PROVIDER_NOT_CONFIGURED",
        statusCode: 501,
      });
    }

    const response = await this.withRetry(() => provider.getFeed({ definition, request }));
    const parsed = FeedResponseSchema.parse(response);
    for (const item of parsed.items) {
      if (!supportsSource(definition, item.source)) {
        throw new PodFeedServiceError(
          `Provider returned unsupported source ${item.source} for feed ${definition.id}`,
          { code: "INVALID_PROVIDER_OUTPUT", statusCode: 500 },
        );
      }
    }

    return {
      items: dedupeItems(parsed.items).slice(0, request.limit),
      cursor: parsed.cursor,
      capabilities: {
        hydrationRequired: true,
        realtimeAvailable: definition.realtimeCapable,
        supportsSse: definition.supportsSse,
        supportsWebSocket: definition.supportsWebSocket,
      },
    };
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
        await sleep(Math.min(delayMs, this.maxDelayMs));
        delayMs = Math.min(delayMs * 2, this.maxDelayMs);
      }
    }
  }
}

function dedupeItems(items: FeedResponse["items"]): FeedResponse["items"] {
  const seen = new Set<string>();
  const deduped: FeedResponse["items"] = [];
  for (const item of items) {
    if (seen.has(item.stableId)) {
      continue;
    }
    seen.add(item.stableId);
    deduped.push(item);
  }
  return deduped;
}
