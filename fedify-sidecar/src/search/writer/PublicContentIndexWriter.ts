/**
 * V6.5 Phase 5.25: Unified Public Indexing Addendum
 *
 * PublicContentIndexWriter
 * Consumes: search.public.upsert.v1, search.public.delete.v1
 * Writes: OpenSearch public-content-v1 index
 */

import { SearchPublicUpsertV1, SearchPublicDeleteV1, SearchPublicPartialUpdateV1 } from '../events/SearchEvents';
import { PublicContentDocument } from '../models/PublicContentDocument';
import { SearchDocAliasCache } from './SearchDocAliasCache';
import { SearchDedupService } from '../aliases/SearchDedupService';

export interface OpenSearchClient {
  get(id: string): Promise<PublicContentDocument | null>;
  upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void>;
  updateScripted(id: string, script: string, params: Record<string, any>): Promise<void>;
  delete(id: string): Promise<void>;
}

export class PublicContentIndexWriter {
  constructor(
    private readonly osClient: OpenSearchClient,
    private readonly aliasCache: SearchDocAliasCache,
    private readonly dedupService: SearchDedupService
  ) {}

  async onUpsert(event: SearchPublicUpsertV1): Promise<void> {
    if (event.upsertKind === 'partial') {
      // For partial upserts, we just update the existing document
      // In a real system, we'd need to handle the case where the document doesn't exist yet
      // For this phase, we assume it exists or we ignore it
      return;
    }

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
      emojis: event.content.emojis,
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

  async onPartialUpdate(event: SearchPublicPartialUpdateV1): Promise<void> {
    if (event.updateKind === 'engagement_delta' && event.deltas) {
      const script = `
        if (ctx._source.engagement == null) {
          ctx._source.engagement = ['likeCount': 0, 'repostCount': 0, 'replyCount': 0];
        }
        if (params.likeDelta != null) ctx._source.engagement.likeCount += params.likeDelta;
        if (params.repostDelta != null) ctx._source.engagement.repostCount += params.repostDelta;
        if (params.replyDelta != null) ctx._source.engagement.replyCount += params.replyDelta;
        ctx._source.indexedAt = params.indexedAt;
      `;
      
      await this.osClient.updateScripted(event.stableDocId, script, {
        likeDelta: event.deltas.likeCount,
        repostDelta: event.deltas.repostCount,
        replyDelta: event.deltas.replyCount,
        indexedAt: event.indexedAt
      });
    } else if (event.partialFields) {
      await this.osClient.upsert(event.stableDocId, {
        ...event.partialFields,
        indexedAt: event.indexedAt
      });
    }
  }

  async onDelete(event: SearchPublicDeleteV1): Promise<void> {
    // Tombstones from the AP projector are emitted with ap:objectUri as the
    // stableDocId, but local content was indexed under its canonicalContentId
    // (the raw objectUri, without the ap: prefix).  Resolve via alias cache so
    // deletes always hit the right document.
    const resolvedId = await this.resolveDeleteStableDocId(event.stableDocId);

    if (event.deleteMode === 'hard') {
      await this.osClient.delete(resolvedId);
    } else {
      const existingDoc = await this.osClient.get(resolvedId);
      if (existingDoc) {
        await this.osClient.upsert(resolvedId, {
          isDeleted: true,
          indexedAt: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Resolve the actual stableDocId to use for a delete operation.
   * Tombstones may arrive with ap: or at: prefixed IDs; if the alias cache
   * has a mapping for the underlying URI, use that instead.
   */
  private async resolveDeleteStableDocId(stableDocId: string): Promise<string> {
    if (stableDocId.startsWith('ap:')) {
      const resolved = await this.aliasCache.getByApUri(stableDocId.slice(3));
      if (resolved) return resolved;
    } else if (stableDocId.startsWith('at:')) {
      const resolved = await this.aliasCache.getByAtUri(stableDocId.slice(3));
      if (resolved) return resolved;
    }
    return stableDocId;
  }
}
