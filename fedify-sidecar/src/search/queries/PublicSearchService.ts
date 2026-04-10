/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * PublicSearchService
 * Exposes three query modes: lexical, semantic, and hybrid.
 */

import { HybridQueryBuilder } from './HybridQueryBuilder.js';
import { EmbeddingService } from '../embeddings/EmbeddingIngestWorker.js';

export interface PublicSearchInput {
  query: string;
  langs?: string[];
  tags?: string[];
  limit: number;
  cursor?: string;
  mode?: 'lexical' | 'semantic' | 'hybrid';
}

export interface SearchResult {
  stableDocId: string;
  score: number;
}

export interface PublicSearchService {
  search(input: PublicSearchInput): Promise<{
    results: SearchResult[];
    cursor?: string;
  }>;
}

export class DefaultPublicSearchService implements PublicSearchService {
  private readonly indexName = 'public-content-v1';
  private readonly pipelineName = 'public-hybrid-pipeline-v1';

  constructor(
    private readonly osClient: any, // OpenSearch JS client
    private readonly queryBuilder: HybridQueryBuilder,
    private readonly embeddingService: EmbeddingService
  ) {}

  async search(input: PublicSearchInput): Promise<{
    results: SearchResult[];
    cursor?: string;
  }> {
    const mode = input.mode || 'hybrid';
    const filters = this.buildFilters(input);
    
    let body: any;
    let usePipeline = false;

    if (mode === 'lexical') {
      body = this.queryBuilder.buildLexicalQuery(input.query, filters);
    } else if (mode === 'semantic') {
      const vector = await this.embeddingService.embedText(input.query);
      body = this.queryBuilder.buildSemanticQuery(vector, input.limit * 2, filters);
    } else {
      // Hybrid
      const vector = await this.embeddingService.embedText(input.query);
      body = this.queryBuilder.buildHybridQuery(input.query, vector, input.limit * 2, filters);
      usePipeline = true;
    }

    // Add pagination and source filtering
    body.size = input.limit;
    body._source = { exclude: ['embedding', 'textRaw'] };
    
    // Add sorting
    body.sort = [
      '_score',
      {
        createdAt: {
          order: 'desc'
        }
      }
    ];
    
    if (input.cursor) {
      // In a real implementation, we'd use search_after
      // For simplicity in this phase, we'll just use from/size if cursor is a number
      const from = parseInt(input.cursor, 10);
      if (!isNaN(from)) {
        body.from = from;
      }
    }

    const searchParams: any = {
      index: this.indexName,
      body
    };

    if (usePipeline) {
      searchParams.search_pipeline = this.pipelineName;
    }

    try {
      const response = await this.osClient.search(searchParams);
      
      const hits = response.body.hits.hits;
      const results = hits.map((hit: any) => ({
        stableDocId: hit._source.stableDocId || hit._id,
        score: hit._score
      }));

      // Calculate next cursor
      const nextCursor = hits.length === input.limit 
        ? ((body.from || 0) + hits.length).toString() 
        : undefined;

      return {
        results,
        cursor: nextCursor
      };
    } catch (error) {
      console.error('Search failed:', error);
      throw error;
    }
  }

  private buildFilters(input: PublicSearchInput): any[] {
    const filters: any[] = [];
    
    if (input.langs && input.langs.length > 0) {
      filters.push({ terms: { langs: input.langs } });
    }
    
    if (input.tags && input.tags.length > 0) {
      filters.push({ terms: { tags: input.tags } });
    }
    
    return filters;
  }
}
