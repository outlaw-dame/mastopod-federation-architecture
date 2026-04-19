/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * FeedCandidateService
 * Generates candidates from 5 buckets for the feed ranker.
 */

export interface FeedCursor {
  graphCursor?: unknown;
  trendingCursor?: unknown;
  interestCursor?: unknown;
}

export interface FeedCandidateRequest {
  viewerCanonicalId: string;
  feedType: 'home' | 'custom' | 'topic';
  limit: number;
  cursor?: FeedCursor;
  // In a real system, we'd pass user interests, follow graph, etc.
  // For this phase, we mock them in the service.
  interests?: string[];
  followedIds?: string[];
}

export interface FeedCandidate {
  stableDocId: string;
  score: number;
  bucket: string;
}

export interface FeedCandidateResponse {
  candidates: FeedCandidate[];
  nextCursor?: FeedCursor;
}

export interface FeedCandidateService {
  getCandidates(req: FeedCandidateRequest): Promise<FeedCandidateResponse>;
}

export class DefaultFeedCandidateService implements FeedCandidateService {
  private readonly indexName = 'public-content-v1';

  constructor(private readonly osClient: any) {}

  async getCandidates(req: FeedCandidateRequest): Promise<FeedCandidateResponse> {
    const candidates: FeedCandidate[] = [];
    const bucketLimit = Math.ceil(req.limit / 3); // Fetch more per bucket to allow merging
    const nextCursor: FeedCursor = {};

    // 1. Follow Graph Bucket (Lexical filter)
    if (req.followedIds && req.followedIds.length > 0) {
      const { items, lastSort } = await this.fetchGraphBucket(req.followedIds, bucketLimit, req.cursor?.graphCursor);
      candidates.push(...items);
      if (lastSort) nextCursor.graphCursor = lastSort;
    }

    // 2. Trending Bucket (Sort by engagement + recency)
    const { items: trendingItems, lastSort: trendingSort } = await this.fetchTrendingBucket(bucketLimit, req.cursor?.trendingCursor);
    candidates.push(...trendingItems);
    if (trendingSort) nextCursor.trendingCursor = trendingSort;

    // 3. Interest Bucket (Lexical on tags)
    if (req.interests && req.interests.length > 0) {
      const { items: interestItems, lastSort: interestSort } = await this.fetchInterestBucket(req.interests, bucketLimit, req.cursor?.interestCursor);
      candidates.push(...interestItems);
      if (interestSort) nextCursor.interestCursor = interestSort;
    }

    // In a real system, we'd also have:
    // 4. Semantic Expansion Bucket (k-NN on user embedding)
    // 5. Local Affinity Bucket (filter by sourceKind: 'local')

    // Deduplicate and return top N
    const ranked = this.mergeAndRank(candidates, req.limit);
    
    return {
      candidates: ranked,
      nextCursor: Object.keys(nextCursor).length > 0 ? nextCursor : undefined
    };
  }

  private async fetchGraphBucket(followedIds: string[], limit: number, searchAfter?: unknown): Promise<{items: FeedCandidate[], lastSort?: any[]}> {
    try {
      const body: any = {
        size: limit,
        _source: false,
        query: {
          bool: {
            filter: [
              { term: { isDeleted: false } },
              { terms: { 'author.canonicalId': followedIds } }
            ]
          }
        },
        sort: [{ createdAt: 'desc' }, { stableDocId: 'asc' }]
      };
      
      if (Array.isArray(searchAfter)) {
        body.search_after = searchAfter;
      }

      const response = await this.osClient.search({
        index: this.indexName,
        body
      });

      const hits = response.body.hits.hits;
      return {
        items: hits.map((hit: any) => ({
          stableDocId: hit._id,
          score: 1.0, // Base score, ranker will adjust
          bucket: 'graph'
        })),
        lastSort: hits.length > 0 ? hits[hits.length - 1].sort : undefined
      };
    } catch (e) {
      return { items: [] };
    }
  }

  private async fetchTrendingBucket(limit: number, searchAfter?: unknown): Promise<{items: FeedCandidate[], lastSort?: any[]}> {
    try {
      const body: any = {
        size: limit,
        _source: false,
        query: {
          bool: {
            filter: [
              { term: { isDeleted: false } },
              { range: { createdAt: { gte: 'now-24h' } } }
            ]
          }
        },
        sort: [
          { 'engagement.likeCount': 'desc' },
          { 'engagement.repostCount': 'desc' },
          { createdAt: 'desc' },
          { stableDocId: 'asc' }
        ]
      };

      if (Array.isArray(searchAfter)) {
        body.search_after = searchAfter;
      }

      const response = await this.osClient.search({
        index: this.indexName,
        body
      });

      const hits = response.body.hits.hits;
      return {
        items: hits.map((hit: any) => ({
          stableDocId: hit._id,
          score: 0.8,
          bucket: 'trending'
        })),
        lastSort: hits.length > 0 ? hits[hits.length - 1].sort : undefined
      };
    } catch (e) {
      return { items: [] };
    }
  }

  private async fetchInterestBucket(tags: string[], limit: number, searchAfter?: unknown): Promise<{items: FeedCandidate[], lastSort?: any[]}> {
    try {
      const body: any = {
        size: limit,
        _source: false,
        query: {
          bool: {
            must: [
              { terms: { tags } }
            ],
            filter: [
              { term: { isDeleted: false } }
            ]
          }
        },
        sort: [{ createdAt: 'desc' }, { stableDocId: 'asc' }]
      };

      if (Array.isArray(searchAfter)) {
        body.search_after = searchAfter;
      }

      const response = await this.osClient.search({
        index: this.indexName,
        body
      });

      const hits = response.body.hits.hits;
      return {
        items: hits.map((hit: any) => ({
          stableDocId: hit._id,
          score: 0.9,
          bucket: 'interest'
        })),
        lastSort: hits.length > 0 ? hits[hits.length - 1].sort : undefined
      };
    } catch (e) {
      return { items: [] };
    }
  }

  private mergeAndRank(candidates: FeedCandidate[], limit: number): FeedCandidate[] {
    const merged = new Map<string, FeedCandidate>();

    for (const c of candidates) {
      if (!merged.has(c.stableDocId)) {
        merged.set(c.stableDocId, c);
      } else {
        // If found in multiple buckets, boost score
        const existing = merged.get(c.stableDocId)!;
        existing.score += 0.2;
        existing.bucket = `${existing.bucket}+${c.bucket}`;
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
