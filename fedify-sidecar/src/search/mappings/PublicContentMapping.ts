/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * OpenSearch mapping for public-content-v1
 */

export const PublicContentMapping = {
  settings: {
    index: {
      knn: true
    }
  },
  mappings: {
    properties: {
      stableDocId:        { type: 'keyword' },
      canonicalContentId: { type: 'keyword' },

      protocolPresence:   { type: 'keyword' },
      sourceKind:         { type: 'keyword' },

      'ap.objectUri':     { type: 'keyword' },
      'ap.activityUri':   { type: 'keyword' },

      'at.uri':           { type: 'keyword' },
      'at.cid':           { type: 'keyword' },
      'at.did':           { type: 'keyword' },

      'author.canonicalId': { type: 'keyword' },
      'author.apUri':       { type: 'keyword' },
      'author.did':         { type: 'keyword' },
      'author.handle':      { type: 'keyword' },
      'author.displayName': { type: 'text' },

      text:               { type: 'text' },
      createdAt:          { type: 'date' },
      updatedAt:          { type: 'date' },

      langs:              { type: 'keyword' },
      tags:               { type: 'keyword' },

      replyToStableId:    { type: 'keyword' },
      quoteOfStableId:    { type: 'keyword' },

      hasMedia:           { type: 'boolean' },
      mediaCount:         { type: 'integer' },

      'engagement.likeCount':   { type: 'integer' },
      'engagement.repostCount': { type: 'integer' },
      'engagement.replyCount':  { type: 'integer' },

      'ranking.recencyBucket':      { type: 'keyword' },
      'ranking.localAffinityScore': { type: 'float' },
      'ranking.graphAffinityScore': { type: 'float' },
      'ranking.qualityScore':       { type: 'float' },

      embedding: {
        type: 'knn_vector',
        dimension: 1024,
        space_type: 'cosinesimil',
        mode: 'on_disk',
        compression_level: '16x'
      },

      isDeleted:          { type: 'boolean' },
      indexedAt:          { type: 'date' }
    }
  }
};
