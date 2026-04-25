import type { PublicContentDocument } from "../models/PublicContentDocument.js";
import type {
  FeedCandidate,
  FeedCandidateRequest,
  FeedCandidateResponse,
  FeedCandidateService,
  FeedCursor,
} from "./FeedCandidateService.js";
import { QdrantDocumentStore } from "../../feed/QdrantDocumentStore.js";

type QdrantOrderCursor = {
  startFrom: string | number | null;
  excludeIds: string[];
};

type OrderDirection = "asc" | "desc";

type BucketResult = {
  items: FeedCandidate[];
  cursor?: QdrantOrderCursor;
};

export class QdrantFeedCandidateService implements FeedCandidateService {
  constructor(private readonly store: QdrantDocumentStore) {}

  async getCandidates(req: FeedCandidateRequest): Promise<FeedCandidateResponse> {
    const candidates: FeedCandidate[] = [];
    const bucketLimit = Math.ceil(req.limit / 3);
    const nextCursor: FeedCursor = {};

    if (req.followedIds && req.followedIds.length > 0) {
      const graph = await this.fetchGraphBucket(req.followedIds, bucketLimit, parseOrderCursor(req.cursor?.graphCursor));
      candidates.push(...graph.items);
      if (graph.cursor) {
        nextCursor.graphCursor = graph.cursor;
      }
    }

    const trending = await this.fetchTrendingBucket(bucketLimit, parseOrderCursor(req.cursor?.trendingCursor));
    candidates.push(...trending.items);
    if (trending.cursor) {
      nextCursor.trendingCursor = trending.cursor;
    }

    if (req.interests && req.interests.length > 0) {
      const interest = await this.fetchInterestBucket(req.interests, bucketLimit, parseOrderCursor(req.cursor?.interestCursor));
      candidates.push(...interest.items);
      if (interest.cursor) {
        nextCursor.interestCursor = interest.cursor;
      }
    }

    const ranked = mergeAndRank(candidates, req.limit);

    return {
      candidates: ranked,
      nextCursor: Object.keys(nextCursor).length > 0 ? nextCursor : undefined,
    };
  }

  private async fetchGraphBucket(
    followedIds: string[],
    limit: number,
    cursor?: QdrantOrderCursor,
  ): Promise<BucketResult> {
    const filter = mergeFilterWithCursor(
      {
        must: [{ key: "isDeleted", match: { value: false } }],
        should: buildAuthorIdentityShould(followedIds),
        min_should: 1,
      },
      cursor,
    );

    const result = await this.store.scroll({
      filter,
      limit,
      orderBy: buildOrderBy("createdAt", "desc", cursor),
    });

    return {
      items: result.points.map((doc) => ({
        stableDocId: doc.stableDocId,
        score: 1.0,
        bucket: "graph",
      })),
      cursor: buildNextCursor(result.rawPoints, limit, "createdAt"),
    };
  }

  private async fetchTrendingBucket(limit: number, cursor?: QdrantOrderCursor): Promise<BucketResult> {
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const filter = mergeFilterWithCursor(
      {
        must: [{ key: "isDeleted", match: { value: false } }],
      },
      cursor,
    );

    const result = await this.store.scroll({
      filter,
      limit,
      orderBy: buildOrderBy("engagement.likeCount", "desc", cursor),
    });

    const items = result.points
      .filter((doc) => Date.parse(doc.createdAt) >= sinceMs)
      .sort(compareTrendingDocs)
      .map((doc) => ({
        stableDocId: doc.stableDocId,
        score: 0.8,
        bucket: "trending",
      }));

    return {
      items,
      cursor: buildNextCursor(result.rawPoints, limit, "engagement.likeCount"),
    };
  }

  private async fetchInterestBucket(tags: string[], limit: number, cursor?: QdrantOrderCursor): Promise<BucketResult> {
    const filter = mergeFilterWithCursor(
      {
        must: [
          { key: "isDeleted", match: { value: false } },
          { should: tags.map((tag) => ({ key: "tags", match: { value: tag } })), min_should: 1 },
        ],
      },
      cursor,
    );

    const result = await this.store.scroll({
      filter,
      limit,
      orderBy: buildOrderBy("createdAt", "desc", cursor),
    });

    return {
      items: result.points.map((doc) => ({
        stableDocId: doc.stableDocId,
        score: 0.9,
        bucket: "interest",
      })),
      cursor: buildNextCursor(result.rawPoints, limit, "createdAt"),
    };
  }
}

function buildAuthorIdentityShould(followedIds: string[]): Array<Record<string, unknown>> {
  const conditions: Array<Record<string, unknown>> = [];
  for (const followedId of followedIds) {
    conditions.push({ key: "author.canonicalId", match: { value: followedId } });
    conditions.push({ key: "author.apUri", match: { value: followedId } });
    conditions.push({ key: "author.did", match: { value: followedId } });
    conditions.push({ key: "author.handle", match: { value: followedId } });
  }
  return conditions;
}

function mergeFilterWithCursor(filter: Record<string, unknown>, cursor?: QdrantOrderCursor): Record<string, unknown> {
  if (!cursor || cursor.excludeIds.length === 0) {
    return filter;
  }

  const existingMustNot = Array.isArray((filter as any).must_not) ? [...((filter as any).must_not as unknown[])] : [];
  existingMustNot.push({ has_id: cursor.excludeIds });
  return {
    ...filter,
    must_not: existingMustNot,
  };
}

function buildOrderBy(
  key: string,
  direction: OrderDirection,
  cursor?: QdrantOrderCursor,
): { key: string; direction: OrderDirection; start_from?: string | number | null } {
  return {
    key,
    direction,
    ...(cursor && cursor.startFrom !== null && cursor.startFrom !== undefined
      ? { start_from: cursor.startFrom }
      : {}),
  };
}

function buildNextCursor(
  rawPoints: Array<{ id: string | number; payload?: Record<string, unknown>; order_value?: string | number | null }>,
  limit: number,
  orderKey: string,
): QdrantOrderCursor | undefined {
  if (rawPoints.length < limit || rawPoints.length === 0) {
    return undefined;
  }

  const lastPoint = rawPoints[rawPoints.length - 1];
  if (!lastPoint) {
    return undefined;
  }
  const lastValue = lastPoint.order_value ?? getPayloadValue(lastPoint.payload, orderKey);
  if (typeof lastValue !== "string" && typeof lastValue !== "number") {
    return undefined;
  }

  const excludeIds = rawPoints
    .filter((point) => {
      const pointValue = point.order_value ?? getPayloadValue(point.payload, orderKey);
      return pointValue === lastValue;
    })
    .map((point) => String(point.id));

  return {
    startFrom: lastValue,
    excludeIds,
  };
}

function parseOrderCursor(value: unknown): QdrantOrderCursor | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const startFrom = (value as any).startFrom;
  const excludeIds = Array.isArray((value as any).excludeIds)
    ? (value as any).excludeIds.filter((entry: unknown): entry is string => typeof entry === "string")
    : [];

  if (startFrom !== null && typeof startFrom !== "string" && typeof startFrom !== "number") {
    return undefined;
  }

  return {
    startFrom: startFrom ?? null,
    excludeIds,
  };
}

function compareTrendingDocs(a: PublicContentDocument, b: PublicContentDocument): number {
  const aLike = safeInt(a.engagement?.likeCount);
  const bLike = safeInt(b.engagement?.likeCount);
  if (aLike !== bLike) {
    return bLike - aLike;
  }

  const aRepost = safeInt(a.engagement?.repostCount);
  const bRepost = safeInt(b.engagement?.repostCount);
  if (aRepost !== bRepost) {
    return bRepost - aRepost;
  }

  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  if (aCreated !== bCreated) {
    return bCreated - aCreated;
  }

  return a.stableDocId.localeCompare(b.stableDocId);
}

function safeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function mergeAndRank(candidates: FeedCandidate[], limit: number): FeedCandidate[] {
  const merged = new Map<string, FeedCandidate>();

  for (const candidate of candidates) {
    if (!merged.has(candidate.stableDocId)) {
      merged.set(candidate.stableDocId, candidate);
      continue;
    }

    const existing = merged.get(candidate.stableDocId)!;
    existing.score += 0.2;
    existing.bucket = `${existing.bucket}+${candidate.bucket}`;
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.stableDocId.localeCompare(b.stableDocId))
    .slice(0, limit);
}

function getPayloadValue(payload: Record<string, unknown> | undefined, key: string): string | number | null {
  if (!payload) {
    return null;
  }

  const parts = key.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return typeof current === "string" || typeof current === "number" ? current : null;
}