import { FeedCandidateService, type FeedCandidateRequest, type FeedCursor } from "../search/queries/FeedCandidateService.js";
import type { PublicContentDocument } from "../search/models/PublicContentDocument.js";
import type { PodFeedProvider, ResolvedFeedRequest } from "./PodFeedService.js";
import type { FeedResponse, FeedSource } from "./contracts.js";
import {
  classifyOpenSearchRetryReason,
  withOpenSearchRetry,
  type OpenSearchRetryPolicy,
} from "./OpenSearchRetry.js";
import { metrics as promMetrics } from "../metrics/index.js";

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

export class OpenSearchFeedProvider implements PodFeedProvider {
  private readonly indexName: string;
  private readonly retryPolicy: Partial<OpenSearchRetryPolicy>;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly osClient: OpenSearchSearchClient,
    private readonly candidateService: FeedCandidateService,
    options: { indexName?: string; retryPolicy?: Partial<OpenSearchRetryPolicy>; requestTimeoutMs?: number } = {},
  ) {
    this.indexName = options.indexName ?? "public-content-v1";
    this.retryPolicy = options.retryPolicy ?? {};
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(250, Math.min(options.requestTimeoutMs as number, 30_000))
      : 3_000;
  }

  async getFeed(input: ResolvedFeedRequest): Promise<FeedResponse> {
    const candidateRequest = this.toCandidateRequest(input);
    const candidateResult = await this.candidateService.getCandidates(candidateRequest);

    const candidateIds = candidateResult.candidates.map((candidate) => candidate.stableDocId);
    if (candidateIds.length === 0) {
      return {
        items: [],
        cursor: encodeCursor(candidateResult.nextCursor),
        capabilities: {
          hydrationRequired: true,
          realtimeAvailable: false,
          supportsSse: false,
          supportsWebSocket: false,
        },
      };
    }

    const documentsById = await this.fetchDocumentsById(candidateIds);
    const filterLangs = input.request.filters?.langs ?? [];
    const filterLangSet = new Set(filterLangs.map((lang) => lang.toLowerCase()));

    const items = candidateResult.candidates
      .map((candidate) => {
        const doc = documentsById.get(candidate.stableDocId);
        if (!doc) {
          return null;
        }
        if (!matchesLangFilter(doc, filterLangSet)) {
          return null;
        }

        const canonicalUri = selectCanonicalUri(doc);
        const activityPubObjectId = selectActivityPubObjectId(doc);
        if (!canonicalUri && !activityPubObjectId) {
          return null;
        }

        const source = selectFeedSource(doc, input.definition.sourcePolicy);
        if (!source) {
          return null;
        }

        return {
          stableId: doc.stableDocId,
          canonicalUri: canonicalUri ?? undefined,
          activityPubObjectId: activityPubObjectId ?? undefined,
          source,
          score: Number.isFinite(candidate.score) ? candidate.score : undefined,
          publishedAt: normalizeIso(doc.createdAt) ?? undefined,
          authorId: selectAuthorId(doc) ?? undefined,
          hints: {
            reason: normalizeHint(candidate.bucket),
            rankBucket: normalizeHint(candidate.bucket),
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return {
      items,
      cursor: encodeCursor(candidateResult.nextCursor),
      capabilities: {
        hydrationRequired: true,
        realtimeAvailable: false,
        supportsSse: false,
        supportsWebSocket: false,
      },
    };
  }

  private toCandidateRequest(input: ResolvedFeedRequest): FeedCandidateRequest {
    const decodedCursor = decodeCursor(input.request.cursor);
    const feedType = toCandidateFeedType(input.definition.kind);
    return {
      viewerCanonicalId: input.request.viewerId ?? "anonymous",
      feedType,
      limit: input.request.limit,
      ...(decodedCursor ? { cursor: decodedCursor } : {}),
      ...(input.request.filters?.tags ? { interests: input.request.filters.tags } : {}),
      ...(input.request.filters?.authors ? { followedIds: input.request.filters.authors } : {}),
    };
  }

  private async fetchDocumentsById(stableDocIds: string[]): Promise<Map<string, PublicContentDocument>> {
    const response = await withOpenSearchRetry(
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
        promMetrics.feedOpenSearchRetriesTotal.inc({
          component: "provider",
          reason: classifyOpenSearchRetryReason(event.error),
        });
      },
    );

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
}

function toCandidateFeedType(kind: string): "home" | "custom" | "topic" {
  if (kind === "graph") {
    return "home";
  }
  if (kind === "topic") {
    return "topic";
  }
  return "custom";
}

function decodeCursor(raw: string | undefined): FeedCursor | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as FeedCursor;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(cursor: FeedCursor | undefined): string | undefined {
  if (!cursor || Object.keys(cursor).length === 0) {
    return undefined;
  }

  try {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  } catch {
    return undefined;
  }
}

function matchesLangFilter(doc: PublicContentDocument, filterLangSet: Set<string>): boolean {
  if (filterLangSet.size === 0) {
    return true;
  }
  const docLangs = (doc.langs ?? []).map((lang) => lang.toLowerCase());
  return docLangs.some((lang) => filterLangSet.has(lang));
}

function isSafeUrl(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isSafeDid(value: string | undefined): value is string {
  return Boolean(value && value.startsWith("did:") && !/[\u0000-\u001F\u007F]/.test(value));
}

function selectCanonicalUri(doc: PublicContentDocument): string | null {
  if (isSafeUrl(doc.canonicalContentId)) {
    return doc.canonicalContentId;
  }
  if (isSafeUrl(doc.ap?.objectUri)) {
    return doc.ap.objectUri;
  }
  if (isSafeUrl(doc.at?.uri)) {
    return doc.at.uri;
  }
  return null;
}

function selectActivityPubObjectId(doc: PublicContentDocument): string | null {
  return isSafeUrl(doc.ap?.objectUri) ? doc.ap.objectUri : null;
}

function selectAuthorId(doc: PublicContentDocument): string | null {
  if (isSafeUrl(doc.author.apUri)) {
    return doc.author.apUri;
  }
  if (isSafeDid(doc.author.did)) {
    return doc.author.did;
  }
  return null;
}

function normalizeIso(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
}

function selectFeedSource(
  doc: PublicContentDocument,
  sourcePolicy: {
    includeStream1: boolean;
    includeStream2: boolean;
    includeCanonical: boolean;
    includeFirehose: boolean;
    includeUnified: boolean;
  },
): FeedSource | null {
  if (doc.sourceKind === "local" && sourcePolicy.includeStream1) {
    return "stream1";
  }
  if (doc.sourceKind === "remote" && sourcePolicy.includeStream2) {
    return "stream2";
  }
  if (sourcePolicy.includeCanonical) {
    return "canonical";
  }
  if (sourcePolicy.includeFirehose) {
    return "firehose";
  }
  if (sourcePolicy.includeUnified) {
    return "unified";
  }
  return null;
}

function normalizeHint(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_+-]/g, "-").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "candidate";
}
