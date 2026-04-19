import { logger } from "../utils/logger.js";
import { metrics as promMetrics } from "../metrics/index.js";
import type { PublicContentDocument } from "../search/models/PublicContentDocument.js";
import {
  classifySearchReadRetryReason,
  type SearchReadRetryPolicy,
  withSearchReadRetry,
} from "./OpenSearchRetry.js";
import type { SearchDocumentLookupInput, SearchDocumentStore } from "./SearchDocumentStore.js";

type QdrantPointId = string | number;

type QdrantRecord = {
  id: QdrantPointId;
  payload?: Record<string, unknown>;
  vector?: number[] | Record<string, number[]>;
  order_value?: string | number | null;
};

type QdrantRetrieveResponse = {
  result?: QdrantRecord[];
};

type QdrantScrollResponse = {
  result?: {
    points?: QdrantRecord[];
    next_page_offset?: QdrantPointId | null;
  };
};

export interface QdrantDocumentStoreConfig {
  baseUrl: string;
  apiKey?: string;
  collectionName: string;
  requestTimeoutMs: number;
  retryPolicy?: Partial<SearchReadRetryPolicy>;
}

export interface QdrantScrollRequest {
  filter?: Record<string, unknown>;
  limit: number;
  orderBy?: string | { key: string; direction?: "asc" | "desc"; start_from?: string | number | null };
  withVector?: boolean;
}

export interface QdrantScrollResult {
  points: PublicContentDocument[];
  rawPoints: QdrantRecord[];
}

export class QdrantDocumentStore implements SearchDocumentStore {
  private readonly retryPolicy: Partial<SearchReadRetryPolicy>;

  constructor(private readonly config: QdrantDocumentStoreConfig) {
    this.retryPolicy = config.retryPolicy ?? {};
  }

  async fetchByStableIds(stableDocIds: string[]): Promise<Map<string, PublicContentDocument>> {
    if (stableDocIds.length === 0) {
      return new Map();
    }

    const response = await this.request<QdrantRetrieveResponse>(
      "POST",
      `/collections/${encodeURIComponent(this.config.collectionName)}/points`,
      {
        ids: stableDocIds,
        with_payload: true,
        with_vector: false,
      },
      "document_store",
    );

    const byId = new Map<string, PublicContentDocument>();
    for (const point of response.result ?? []) {
      const doc = mapPointToDocument(point);
      if (doc && !doc.isDeleted) {
        byId.set(doc.stableDocId, doc);
      }
    }
    return byId;
  }

  async fetchByIdentifiers(input: SearchDocumentLookupInput): Promise<PublicContentDocument[]> {
    const docsById = new Map<string, PublicContentDocument>();

    if (input.stableIds.size > 0) {
      const byStableId = await this.fetchByStableIds([...input.stableIds]);
      for (const [stableId, doc] of byStableId.entries()) {
        docsById.set(stableId, doc);
      }
    }

    const should: Array<Record<string, unknown>> = [];
    for (const canonicalUri of input.canonicalUris) {
      should.push({ key: "canonicalContentId", match: { value: canonicalUri } });
    }
    for (const apObjectId of input.activityPubObjectIds) {
      should.push({ key: "ap.objectUri", match: { value: apObjectId } });
    }

    if (should.length > 0) {
      const scroll = await this.scroll({
        filter: {
          must: [{ key: "isDeleted", match: { value: false } }],
          should,
          min_should: 1,
        },
        limit: Math.min(should.length * 100, 500),
      });

      for (const doc of scroll.points) {
        docsById.set(doc.stableDocId, doc);
      }
    }

    return [...docsById.values()];
  }

  async scroll(request: QdrantScrollRequest): Promise<QdrantScrollResult> {
    const response = await this.request<QdrantScrollResponse>(
      "POST",
      `/collections/${encodeURIComponent(this.config.collectionName)}/points/scroll`,
      {
        filter: request.filter,
        limit: request.limit,
        with_payload: true,
        with_vector: request.withVector === true,
        ...(request.orderBy ? { order_by: request.orderBy } : {}),
      },
      "candidate_service",
    );

    const rawPoints = response.result?.points ?? [];
    const points = rawPoints
      .map((point) => mapPointToDocument(point))
      .filter((doc): doc is PublicContentDocument => Boolean(doc && !doc.isDeleted));

    return { points, rawPoints };
  }

  private async request<T>(
    method: string,
    path: string,
    body: Record<string, unknown>,
    component: "document_store" | "candidate_service",
  ): Promise<T> {
    return withSearchReadRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

        try {
          const response = await fetch(`${this.config.baseUrl}${path}`, {
            method,
            headers: {
              "content-type": "application/json",
              ...(this.config.apiKey ? { "api-key": this.config.apiKey } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const responseText = await response.text();
            const error = new Error(`Qdrant read request failed (${response.status} ${response.statusText}): ${responseText}`);
            (error as any).statusCode = response.status;
            throw error;
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timeout);
        }
      },
      this.retryPolicy,
      (event) => {
        promMetrics.feedSearchReadRetriesTotal.inc({
          backend: "qdrant",
          component,
          reason: classifySearchReadRetryReason(event.error),
        });
      },
    ).catch((error) => {
      logger.error("[QdrantDocumentStore] Read request failed", {
        method,
        path,
        component,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  }
}

function mapPointToDocument(point: QdrantRecord): PublicContentDocument | null {
  const payload = (point.payload ?? {}) as Partial<PublicContentDocument>;
  if (!payload.stableDocId && typeof point.id !== "string" && typeof point.id !== "number") {
    return null;
  }

  const vector = point.vector;
  const namedVectors = !Array.isArray(vector) && vector ? (vector as Record<string, number[]>) : undefined;
  const denseVector = namedVectors?.["dense"];
  const denseEmbedding = Array.isArray(vector)
    ? vector
    : Array.isArray(denseVector)
      ? denseVector
      : payload.embedding;

  return {
    ...payload,
    stableDocId: payload.stableDocId ?? String(point.id),
    protocolPresence: payload.protocolPresence ?? [],
    sourceKind: payload.sourceKind ?? "remote",
    author: payload.author ?? {},
    text: payload.text ?? "",
    createdAt: payload.createdAt ?? new Date(0).toISOString(),
    hasMedia: payload.hasMedia ?? false,
    mediaCount: payload.mediaCount ?? 0,
    isDeleted: payload.isDeleted ?? false,
    indexedAt: payload.indexedAt ?? new Date().toISOString(),
    ...(denseEmbedding ? { embedding: denseEmbedding } : {}),
  };
}