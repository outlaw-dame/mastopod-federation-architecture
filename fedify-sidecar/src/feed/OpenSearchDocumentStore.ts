import type { PublicContentDocument } from "../search/models/PublicContentDocument.js";
import { metrics as promMetrics } from "../metrics/index.js";
import {
  classifySearchReadRetryReason,
  type SearchReadRetryPolicy,
  withSearchReadRetry,
} from "./OpenSearchRetry.js";
import type { SearchDocumentLookupInput, SearchDocumentStore } from "./SearchDocumentStore.js";

type OpenSearchSearchResponse<T> = {
  body?: {
    hits?: {
      hits?: Array<{
        _id: string;
        _source?: T;
      }>;
    };
  };
};

export interface OpenSearchSearchClient {
  search(params: Record<string, unknown>): Promise<OpenSearchSearchResponse<PublicContentDocument>>;
}

export interface OpenSearchDocumentStoreOptions {
  indexName?: string;
  retryPolicy?: Partial<SearchReadRetryPolicy>;
  requestTimeoutMs?: number;
}

export class OpenSearchDocumentStore implements SearchDocumentStore {
  private readonly indexName: string;
  private readonly retryPolicy: Partial<SearchReadRetryPolicy>;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly osClient: OpenSearchSearchClient,
    options: OpenSearchDocumentStoreOptions = {},
  ) {
    this.indexName = options.indexName ?? "public-content-v1";
    this.retryPolicy = options.retryPolicy ?? {};
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(250, Math.min(options.requestTimeoutMs as number, 30_000))
      : 3_000;
  }

  async fetchByStableIds(stableDocIds: string[]): Promise<Map<string, PublicContentDocument>> {
    if (stableDocIds.length === 0) {
      return new Map();
    }

    const response = await withSearchReadRetry(
      () =>
        this.osClient.search({
          index: this.indexName,
          body: {
            timeout: `${this.requestTimeoutMs}ms`,
            size: Math.min(stableDocIds.length, 200),
            query: {
              bool: {
                filter: [
                  { term: { isDeleted: false } },
                  { terms: { stableDocId: stableDocIds } },
                ],
              },
            },
          },
        }),
      this.retryPolicy,
      (event) => {
        promMetrics.feedSearchReadRetriesTotal.inc({
          backend: "opensearch",
          component: "document_store",
          reason: classifySearchReadRetryReason(event.error),
        });
      },
    );

    return mapResponseToDocuments(response);
  }

  async fetchByIdentifiers(input: SearchDocumentLookupInput): Promise<PublicContentDocument[]> {
    const shouldClauses: Array<Record<string, unknown>> = [];
    if (input.stableIds.size > 0) {
      shouldClauses.push({ terms: { stableDocId: [...input.stableIds] } });
    }
    if (input.canonicalUris.size > 0) {
      shouldClauses.push({ terms: { canonicalContentId: [...input.canonicalUris] } });
    }
    if (input.activityPubObjectIds.size > 0) {
      shouldClauses.push({ terms: { "ap.objectUri": [...input.activityPubObjectIds] } });
    }

    if (shouldClauses.length === 0) {
      return [];
    }

    const response = await withSearchReadRetry(
      () =>
        this.osClient.search({
          index: this.indexName,
          body: {
            timeout: `${this.requestTimeoutMs}ms`,
            size: Math.min(shouldClauses.length * 100, 500),
            query: {
              bool: {
                filter: [{ term: { isDeleted: false } }],
                should: shouldClauses,
                minimum_should_match: 1,
              },
            },
          },
        }),
      this.retryPolicy,
      (event) => {
        promMetrics.feedSearchReadRetriesTotal.inc({
          backend: "opensearch",
          component: "document_store",
          reason: classifySearchReadRetryReason(event.error),
        });
      },
    );

    return [...mapResponseToDocuments(response).values()];
  }
}

function mapResponseToDocuments(
  response: OpenSearchSearchResponse<PublicContentDocument>,
): Map<string, PublicContentDocument> {
  const hits = response.body?.hits?.hits ?? [];
  const byId = new Map<string, PublicContentDocument>();
  for (const hit of hits) {
    if (!hit._source?.stableDocId) {
      continue;
    }
    byId.set(hit._source.stableDocId, hit._source);
  }
  return byId;
}