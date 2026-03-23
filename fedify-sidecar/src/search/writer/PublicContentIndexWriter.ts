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
import { SearchDedupService } from '../aliases/SearchDedupService';

export interface OpenSearchClient {
  get(id: string): Promise<PublicContentDocument | null>;
  upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void>;
  delete(id: string): Promise<void>;
}

export class PublicContentIndexWriter {
  constructor(
    private readonly osClient: OpenSearchClient,
    private readonly aliasCache: SearchDocAliasCache,
    private readonly dedupService: SearchDedupService
  ) {}

  async onUpsert(event: SearchPublicUpsertV1): Promise<void> {
    // 1. Determine the target stableDocId using DedupService
    const targetDocId = await this.dedupService.resolveStableDocId(event);

    // 2. Fetch existing document if any
    const existingDoc = await this.osClient.get(targetDocId);

    // 3. Check if we should merge (for remote content)
    if (existingDoc && existingDoc.sourceKind === 'remote' && event.sourceKind === 'remote') {
      const shouldMerge = await this.dedupService.shouldMergeRemoteDuplicate(existingDoc, event);
      if (!shouldMerge) {
        // If we shouldn't merge, we need a new stableDocId to avoid overwriting
        // In a real system, we might append a hash or timestamp
        // For now, we'll just log and skip to avoid corrupting the index
        console.warn(`Skipping merge for remote duplicate: ${targetDocId}`);
        return;
      }
    }

    // 4. Merge or create
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

    // Initialize engagement if new
    if (!existingDoc) {
      doc.engagement = {
        likeCount: 0,
        repostCount: 0,
        replyCount: 0
      };
    }

    // 5. Upsert to OpenSearch
    await this.osClient.upsert(targetDocId, doc);

    // 6. Update alias cache
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
