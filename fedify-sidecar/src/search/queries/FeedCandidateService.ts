/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * FeedCandidateService
 * Generates candidates from 5 buckets for the feed ranker.
 */

export interface FeedCandidateRequest {
  viewerCanonicalId: string;
  feedType: 'home' | 'custom' | 'topic';
  limit: number;
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

export interface FeedCandidateService {
  getCandidates(req: FeedCandidateRequest): Promise<FeedCandidate[]>;
}

export class DefaultFeedCandidateService implements FeedCandidateService {
  private readonly indexName = 'public-content-v1';

  constructor(private readonly osClient: any) {}

  async getCandidates(req: FeedCandidateRequest): Promise<FeedCandidate[]> {
    const candidates: FeedCandidate[] = [];
    const bucketLimit = Math.ceil(req.limit / 3); // Fetch more per bucket to allow merging

    // 1. Follow Graph Bucket (Lexical filter)
    if (req.followedIds && req.followedIds.length > 0) {
      const graphCandidates = await this.fetchGraphBucket(req.followedIds, bucketLimit);
      candidates.push(...graphCandidates);
    }

    // 2. Trending Bucket (Sort by engagement + recency)
    const trendingCandidates = await this.fetchTrendingBucket(bucketLimit);
    candidates.push(...trendingCandidates);

    // 3. Interest Bucket (Lexical on tags)
    if (req.interests && req.interests.length > 0) {
      const interestCandidates = await this.fetchInterestBucket(req.interests, bucketLimit);
      candidates.push(...interestCandidates);
    }

    // In a real system, we'd also have:
    // 4. Semantic Expansion Bucket (k-NN on user embedding)
    // 5. Local Affinity Bucket (filter by sourceKind: 'local')

    // Deduplicate and return top N
    return this.mergeAndRank(candidates, req.limit);
  }

  private async fetchGraphBucket(followedIds: string[], limit: number): Promise<FeedCandidate[]> {
    try {
      const response = await this.osClient.search({
        index: this.indexName,
        body: {
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
          sort: [{ createdAt: 'desc' }]
        }
      });

      return response.body.hits.hits.map((hit: any) => ({
        stableDocId: hit._id,
        score: 1.0, // Base score, ranker will adjust
        bucket: 'graph'
      }));
    } catch (e) {
      return [];
    }
  }

  private async fetchTrendingBucket(limit: number): Promise<FeedCandidate[]> {
    try {
      const response = await this.osClient.search({
        index: this.indexName,
        body: {
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
            { createdAt: 'desc' }
          ]
        }
      });

      return response.body.hits.hits.map((hit: any) => ({
        stableDocId: hit._id,
        score: 0.8,
        bucket: 'trending'
      }));
    } catch (e) {
      return [];
    }
  }

  private async fetchInterestBucket(tags: string[], limit: number): Promise<FeedCandidate[]> {
    try {
      const response = await this.osClient.search({
        index: this.indexName,
        body: {
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
          sort: [{ createdAt: 'desc' }]
        }
      });

      return response.body.hits.hits.map((hit: any) => ({
        stableDocId: hit._id,
        score: 0.9,
        bucket: 'interest'
      }));
    } catch (e) {
      return [];
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
