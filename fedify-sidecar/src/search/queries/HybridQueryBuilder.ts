/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * HybridQueryBuilder
 * Constructs lexical, semantic, and hybrid queries for OpenSearch.
 */

export class HybridQueryBuilder {
  /**
   * Build a purely lexical query (BM25)
   */
  buildLexicalQuery(query: string, filters: any[] = []) {
    return {
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                fields: ['text^3', 'author.displayName^1.5', 'tags^2']
              }
            }
          ],
          filter: [
            { term: { isDeleted: false } },
            ...filters
          ]
        }
      }
    };
  }

  /**
   * Build a purely semantic query (k-NN)
   */
  buildSemanticQuery(vector: number[], k: number = 100, filters: any[] = []) {
    return {
      query: {
        bool: {
          must: [
            {
              knn: {
                embedding: {
                  vector,
                  k
                }
              }
            }
          ],
          filter: [
            { term: { isDeleted: false } },
            ...filters
          ]
        }
      }
    };
  }

  /**
   * Build a hybrid query (Lexical + Semantic)
   * Requires a search pipeline with normalization-processor to be configured in OpenSearch.
   */
  buildHybridQuery(query: string, vector: number[], k: number = 100, filters: any[] = []) {
    return {
      query: {
        hybrid: {
          queries: [
            {
              bool: {
                must: [
                  {
                    multi_match: {
                      query,
                      fields: ['text^3', 'author.displayName^1.5', 'tags^2']
                    }
                  }
                ],
                filter: [
                  { term: { isDeleted: false } },
                  ...filters
                ]
              }
            },
            {
              knn: {
                embedding: {
                  vector,
                  k
                }
              }
            }
          ]
        }
      }
    };
  }

  /**
   * Build the search pipeline configuration for OpenSearch
   * This should be applied once during index setup.
   */
  getHybridPipelineConfig() {
    return {
      description: "Hybrid search pipeline for public-content-v1",
      phase_results_processors: [
        {
          "normalization-processor": {
            normalization: {
              technique: "min_max"
            },
            combination: {
              technique: "arithmetic_mean",
              parameters: {
                weights: [0.65, 0.35] // 65% lexical, 35% semantic
              }
            }
          }
        }
      ]
    };
  }
}
