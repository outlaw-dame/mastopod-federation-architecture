/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * EmbeddingIngestWorker
 * Async vector enrichment pipeline.
 */

import { OpenSearchClient } from '../writer/PublicContentIndexWriter.js';

export interface EmbeddingService {
  embedText(text: string): Promise<number[]>;
}

export class EmbeddingIngestWorker {
  constructor(
    private readonly osClient: OpenSearchClient,
    private readonly embeddingService: EmbeddingService
  ) {}

  /**
   * Process a document that needs an embedding.
   * This would typically be called from a queue or event listener
   * after the initial upsert.
   */
  async processDocument(stableDocId: string): Promise<void> {
    const doc = await this.osClient.get(stableDocId);
    
    if (!doc) {
      return; // Document might have been deleted
    }

    if (doc.isDeleted) {
      return; // Don't embed deleted content
    }

    if (!doc.text || doc.text.trim().length === 0) {
      return; // Don't embed empty content
    }

    // Skip if already embedded and text hasn't changed
    // (In a real system, we'd hash the text to check if it changed)
    if (doc.embedding && doc.embedding.length > 0) {
      return;
    }

    try {
      const vector = await this.embeddingService.embedText(doc.text);
      
      // Upsert just the embedding and status
      await this.osClient.upsert(stableDocId, {
        embedding: vector,
        embeddingStatus: 'complete',
        embeddingUpdatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Failed to embed document ${stableDocId}:`, error);
      
      // Mark as failed for retry
      await this.osClient.upsert(stableDocId, {
        embeddingStatus: 'failed',
        embeddingUpdatedAt: new Date().toISOString()
      });
    }
  }

  /**
   * Self-healing scan to find and retry pending/failed embeddings.
   * Would be called periodically by a cron job.
   */
  async scanAndRetry(limit: number = 100): Promise<void> {
    // In a real implementation, this would query OpenSearch for:
    // embeddingStatus: 'pending' OR (embeddingStatus: 'failed' AND embeddingUpdatedAt < now - 1h)
    // For this phase, we just define the interface.
    console.log(`Scanning for up to ${limit} documents needing embeddings...`);
  }
}

/**
 * Mock embedding service for testing
 */
export class MockEmbeddingService implements EmbeddingService {
  async embedText(text: string): Promise<number[]> {
    // Return a dummy 1024-dimensional vector
    const vector = new Array(1024).fill(0);
    // Use the text length to make it slightly deterministic for tests
    vector[0] = text.length / 1000;
    return vector;
  }
}
