/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * OpenSearch mapping for public-author-v1
 */

export const PublicAuthorMapping = {
  mappings: {
    properties: {
      stableAuthorId:     { type: 'keyword' },
      canonicalAccountId: { type: 'keyword' },

      apUri:              { type: 'keyword' },
      did:                { type: 'keyword' },
      handle:             { type: 'keyword' },

      displayName:        { type: 'text' },
      summaryText:        { type: 'text' },
      labels:             { type: 'keyword' },
      langs:              { type: 'keyword' },

      protocolPresence:   { type: 'keyword' },
      sourceKind:         { type: 'keyword' },

      updatedAt:          { type: 'date' }
    }
  }
};
