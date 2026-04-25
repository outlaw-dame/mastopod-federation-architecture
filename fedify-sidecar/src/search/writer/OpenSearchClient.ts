/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * OpenSearch Client implementation for the unified public-content-v1 index.
 */

import { PublicContentDocument } from '../models/PublicContentDocument.js';
import { PublicAuthorDocument } from '../models/PublicAuthorDocument.js';
import { PublicContentMapping } from '../mappings/PublicContentMapping.js';
import { PublicAuthorMapping } from '../mappings/PublicAuthorMapping.js';
import { OpenSearchClient as IOpenSearchClient } from './PublicContentIndexWriter.js';
import { OpenSearchAuthorClient as IOpenSearchAuthorClient } from './PublicAuthorIndexWriter.js';

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

  async deleteByAuthor(author: {
    canonicalId?: string;
    apUri?: string;
    did?: string;
    handle?: string;
  }): Promise<void> {
    const should = [
      author.canonicalId ? { term: { "author.canonicalId": author.canonicalId } } : null,
      author.apUri ? { term: { "author.apUri": author.apUri } } : null,
      author.did ? { term: { "author.did": author.did } } : null,
      author.handle ? { term: { "author.handle": author.handle } } : null,
    ].filter(Boolean);

    if (should.length === 0) {
      return;
    }

    await this.client.deleteByQuery({
      index: this.indexName,
      body: {
        query: {
          bool: {
            should,
            minimum_should_match: 1,
          },
        },
      },
      refresh: true,
    });
  }

  /**
   * Initialize the index with the canonical mapping from PublicContentMapping.
   * This is a fallback for when the bootstrap service has not run yet.
   * The bootstrap service should be the primary path for index creation.
   */
  async initializeIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.indexName });
    
    if (!exists.body) {
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: PublicContentMapping.settings,
          mappings: PublicContentMapping.mappings,
        },
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

  async deleteByAuthor(author: {
    canonicalId?: string;
    apUri?: string;
    did?: string;
    handle?: string;
  }): Promise<void> {
    for (const [id, doc] of this.docs.entries()) {
      if (
        (author.canonicalId && doc.author?.canonicalId === author.canonicalId) ||
        (author.apUri && doc.author?.apUri === author.apUri) ||
        (author.did && doc.author?.did === author.did) ||
        (author.handle && doc.author?.handle === author.handle)
      ) {
        this.docs.delete(id);
      }
    }
  }

  // Test helper
  getAll(): PublicContentDocument[] {
    return Array.from(this.docs.values());
  }
}

export class DefaultOpenSearchAuthorClient implements IOpenSearchAuthorClient {
  private readonly indexName = "public-author-v1";

  constructor(private readonly client: any) {}

  async get(id: string): Promise<PublicAuthorDocument | null> {
    try {
      const response = await this.client.get({
        index: this.indexName,
        id,
      });
      return response.body._source as PublicAuthorDocument;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async upsert(id: string, doc: Partial<PublicAuthorDocument>): Promise<void> {
    await this.client.update({
      index: this.indexName,
      id,
      body: {
        doc,
        doc_as_upsert: true,
      },
      refresh: true,
    });
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.delete({
        index: this.indexName,
        id,
        refresh: true,
      });
    } catch (error: any) {
      if (error.meta?.statusCode !== 404) {
        throw error;
      }
    }
  }

  async initializeIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.indexName });

    if (!exists.body) {
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: PublicAuthorMapping.settings,
          mappings: PublicAuthorMapping.mappings,
        },
      });
    }
  }
}

export class InMemoryOpenSearchAuthorClient implements IOpenSearchAuthorClient {
  private docs = new Map<string, PublicAuthorDocument>();

  async get(id: string): Promise<PublicAuthorDocument | null> {
    return this.docs.get(id) || null;
  }

  async upsert(id: string, doc: Partial<PublicAuthorDocument>): Promise<void> {
    const existing = this.docs.get(id) || ({} as PublicAuthorDocument);
    this.docs.set(id, { ...existing, ...doc } as PublicAuthorDocument);
  }

  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }

  getAll(): PublicAuthorDocument[] {
    return Array.from(this.docs.values());
  }
}
