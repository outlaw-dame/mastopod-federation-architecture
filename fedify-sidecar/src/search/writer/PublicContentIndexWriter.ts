/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * PublicContentIndexWriter
 * Consumes: search.public.upsert.v1, search.public.delete.v1
 * Writes: OpenSearch public-content-v1 index
 */

import { SearchPublicUpsertV1, SearchPublicDeleteV1 } from '../events/SearchEvents';
import { PublicContentDocument } from '../models/PublicContentDocument';
import { SearchDocAliasCache } from './SearchDocAliasCache';

export interface OpenSearchClient {
  get(id: string): Promise<PublicContentDocument | null>;
  upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void>;
  delete(id: string): Promise<void>;
}

export class PublicContentIndexWriter {
  constructor(
    private readonly osClient: OpenSearchClient,
    private readonly aliasCache: SearchDocAliasCache
  ) {}

  async onUpsert(event: SearchPublicUpsertV1): Promise<void> {
    // 1. Determine the target stableDocId
    let targetDocId = event.stableDocId;

    // Check cache for existing aliases to merge
    if (event.canonicalContentId) {
      const cached = await this.aliasCache.getByCanonicalId(event.canonicalContentId);
      if (cached) targetDocId = cached;
    } else if (event.ap?.objectUri) {
      const cached = await this.aliasCache.getByApUri(event.ap.objectUri);
      if (cached) targetDocId = cached;
    } else if (event.at?.uri) {
      const cached = await this.aliasCache.getByAtUri(event.at.uri);
      if (cached) targetDocId = cached;
    }

    // 2. Fetch existing document if any
    const existingDoc = await this.osClient.get(targetDocId);

    // 3. Merge or create
    const doc: Partial<PublicContentDocument> = existingDoc ? { ...existingDoc } : {
      stableDocId: targetDocId,
      canonicalContentId: event.canonicalContentId,
      protocolPresence: [],
      sourceKind: event.sourceKind,
      author: event.author,
      text: event.content.text,
      createdAt: event.content.createdAt,
      langs: event.content.langs,
      tags: event.content.tags,
      replyToStableId: event.relations?.replyToStableId,
      quoteOfStableId: event.relations?.quoteOfStableId,
      hasMedia: event.media?.hasMedia || false,
      mediaCount: event.media?.mediaCount || 0,
      isDeleted: false,
      indexedAt: new Date().toISOString()
    };

    // Update protocol presence
    if (!doc.protocolPresence) doc.protocolPresence = [];
    if (!doc.protocolPresence.includes(event.protocolSource)) {
      doc.protocolPresence.push(event.protocolSource);
    }

    // Update AP/AT specific fields
    if (event.ap) {
      doc.ap = { ...doc.ap, ...event.ap };
    }
    if (event.at) {
      doc.at = { ...doc.at, ...event.at };
    }

    // 4. Upsert to OpenSearch
    await this.osClient.upsert(targetDocId, doc);

    // 5. Update alias cache
    if (event.canonicalContentId) {
      await this.aliasCache.setCanonicalId(event.canonicalContentId, targetDocId);
    }
    if (event.ap?.objectUri) {
      await this.aliasCache.setApUri(event.ap.objectUri, targetDocId);
    }
    if (event.at?.uri) {
      await this.aliasCache.setAtUri(event.at.uri, targetDocId);
    }
  }

  async onDelete(event: SearchPublicDeleteV1): Promise<void> {
    // For deletes, we just mark as deleted or remove.
    // The spec says "mark isDeleted = true OR remove document (configurable)".
    // We'll mark as deleted to preserve tombstones.
    
    const existingDoc = await this.osClient.get(event.stableDocId);
    if (existingDoc) {
      await this.osClient.upsert(event.stableDocId, {
        isDeleted: true,
        indexedAt: new Date().toISOString()
      });
    }
  }
}
