/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * OpenSearch mapping for public-author-v1
 */

export const PublicAuthorMapping = {
  settings: {
    index: {
      number_of_shards: 1,
      number_of_replicas: 1
    },
    analysis: {
      analyzer: {
        author_text_analyzer: {
          type: "custom",
          tokenizer: "standard",
          filter: ["lowercase"]
        }
      }
    }
  },
  mappings: {
    dynamic: "strict",
    properties: {
      stableAuthorId:     { type: 'keyword' },
      canonicalAccountId: { type: 'keyword' },

      apUri:              { type: 'keyword' },
      did:                { type: 'keyword' },
      handle:             { type: 'keyword' },

      displayName: {
        type: 'text',
        analyzer: 'author_text_analyzer',
        fields: {
          raw: {
            type: 'keyword',
            ignore_above: 256
          }
        }
      },
      summaryText: {
        type: 'text',
        analyzer: 'author_text_analyzer'
      },
      labels:             { type: 'keyword' },
      langs:              { type: 'keyword' },

      protocolPresence:   { type: 'keyword' },
      sourceKind:         { type: 'keyword' },

      updatedAt: {
        type: 'date',
        format: 'strict_date_optional_time||epoch_millis'
      }
    }
  }
};
