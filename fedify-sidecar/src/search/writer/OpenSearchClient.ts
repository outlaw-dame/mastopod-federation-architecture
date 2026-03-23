/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * OpenSearch Client implementation for the unified public-content-v1 index.
 */

import { PublicContentDocument } from '../models/PublicContentDocument';
import { OpenSearchClient as IOpenSearchClient } from './PublicContentIndexWriter';

export class DefaultOpenSearchClient implements IOpenSearchClient {
  private readonly indexName = 'public-content-v1';

  constructor(private readonly client: any) {}

  async get(id: string): Promise<PublicContentDocument | null> {
    try {
      const response = await this.client.get({
        index: this.indexName,
        id
      });
      return response.body._source as PublicContentDocument;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void> {
    await this.client.update({
      index: this.indexName,
      id,
      body: {
        doc,
        doc_as_upsert: true
      },
      refresh: true // For testing/immediate visibility, in prod might be false
    });
  }

  async updateScripted(id: string, script: string, params: Record<string, any>): Promise<void> {
    await this.client.update({
      index: this.indexName,
      id,
      body: {
        script: {
          source: script,
          params
        }
      },
      refresh: true
    });
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.delete({
        index: this.indexName,
        id,
        refresh: true
      });
    } catch (error: any) {
      if (error.meta?.statusCode !== 404) {
        throw error;
      }
    }
  }

  /**
   * Initialize the index with the correct mapping
   */
  async initializeIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.indexName });
    
    if (!exists.body) {
      await this.client.indices.create({
        index: this.indexName,
        body: {
          mappings: {
            properties: {
              stableDocId: { type: 'keyword' },
              canonicalContentId: { type: 'keyword' },
              protocolPresence: { type: 'keyword' },
              sourceKind: { type: 'keyword' },
              
              ap: {
                properties: {
                  objectUri: { type: 'keyword' },
                  activityUri: { type: 'keyword' }
                }
              },
              
              at: {
                properties: {
                  uri: { type: 'keyword' },
                  cid: { type: 'keyword' },
                  did: { type: 'keyword' }
                }
              },
              
              author: {
                properties: {
                  canonicalId: { type: 'keyword' },
                  apUri: { type: 'keyword' },
                  did: { type: 'keyword' },
                  handle: { type: 'keyword' }
                }
              },
              
              text: { type: 'text' },
              createdAt: { type: 'date' },
              langs: { type: 'keyword' },
              tags: { type: 'keyword' },
              
              replyToStableId: { type: 'keyword' },
              quoteOfStableId: { type: 'keyword' },
              
              hasMedia: { type: 'boolean' },
              mediaCount: { type: 'integer' },
              
              isDeleted: { type: 'boolean' },
              indexedAt: { type: 'date' }
            }
          }
        }
      });
    }
  }
}

/**
 * In-memory mock for testing
 */
export class InMemoryOpenSearchClient implements IOpenSearchClient {
  private docs = new Map<string, PublicContentDocument>();

  async get(id: string): Promise<PublicContentDocument | null> {
    return this.docs.get(id) || null;
  }

  async upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void> {
    const existing = this.docs.get(id) || {} as PublicContentDocument;
    this.docs.set(id, { ...existing, ...doc } as PublicContentDocument);
  }

  async updateScripted(id: string, script: string, params: Record<string, any>): Promise<void> {
    const existing = this.docs.get(id);
    if (!existing) return;
    
    // Mock implementation of the scripted update for engagement
    if (!existing.engagement) {
      existing.engagement = { likeCount: 0, repostCount: 0, replyCount: 0 };
    }
    
    if (params['likeDelta']) existing.engagement.likeCount += params['likeDelta'];
    if (params['repostDelta']) existing.engagement.repostCount += params['repostDelta'];
    if (params['replyDelta']) existing.engagement.replyCount += params['replyDelta'];
    if (params['indexedAt']) existing.indexedAt = params['indexedAt'];
    
    this.docs.set(id, existing);
  }

  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }

  // Test helper
  getAll(): PublicContentDocument[] {
    return Array.from(this.docs.values());
  }
}
