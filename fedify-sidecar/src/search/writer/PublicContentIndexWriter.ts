/**
 * PublicContentIndexWriter
 * Consumes: search.public.upsert.v1, search.public.delete.v1
 * Writes: canonical Tier-3 public content projection.
 */

import {
  SearchPublicUpsertV1,
  SearchPublicDeleteV1,
  SearchPublicDeleteByAuthorV1,
  SearchPublicPartialUpdateV1,
} from '../events/SearchEvents.js';
import { PublicContentDocument } from '../models/PublicContentDocument.js';
import { SearchDocAliasCache } from './SearchDocAliasCache.js';
import { SearchDedupService } from '../aliases/SearchDedupService.js';

export interface PublicContentStore {
  get(id: string): Promise<PublicContentDocument | null>;
  upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void>;
  updateScripted(id: string, script: string, params: Record<string, any>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByAuthor(author: {
    canonicalId?: string;
    apUri?: string;
    did?: string;
    handle?: string;
  }): Promise<void>;
}

export type OpenSearchClient = PublicContentStore;

export class PublicContentIndexWriter {
  constructor(
    private readonly osClient: PublicContentStore,
    private readonly aliasCache: SearchDocAliasCache,
    private readonly dedupService: SearchDedupService,
  ) {}

  async onUpsert(event: SearchPublicUpsertV1): Promise<void> {
    if (event.upsertKind === 'partial') {
      return;
    }

    const targetDocId = await this.dedupService.resolveStableDocId(event);
    const existingDoc = await this.osClient.get(targetDocId);

    if (existingDoc && existingDoc.sourceKind === 'remote' && event.sourceKind === 'remote') {
      const shouldMerge = await this.dedupService.shouldMergeRemoteDuplicate(existingDoc, event);
      if (!shouldMerge) {
        console.warn(`Skipping merge for remote duplicate: ${targetDocId}`);
        return;
      }
    }

    const doc: Partial<PublicContentDocument> = existingDoc
      ? { ...existingDoc }
      : {
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
          indexedAt: new Date().toISOString(),
        };

    // Old documents read from an upgraded physical index may still contain
    // Phase-5.5 embedding metadata. Never copy that retired state forward into
    // OS3 writes, especially when the fresh strict mapping no longer declares it.
    delete doc.embedding;
    delete doc.sparseEmbedding;
    delete doc.embeddingStatus;
    delete doc.embeddingUpdatedAt;

    if (!doc.protocolPresence) doc.protocolPresence = [];
    if (!doc.protocolPresence.includes(event.protocolSource)) {
      doc.protocolPresence.push(event.protocolSource);
    }

    if (event.ap) {
      doc.ap = { ...doc.ap, ...event.ap };
    }
    if (event.at) {
      doc.at = { ...doc.at, ...event.at };
    }

    if (!existingDoc) {
      doc.engagement = {
        likeCount: 0,
        repostCount: 0,
        replyCount: 0,
      };
    }

    await this.osClient.upsert(targetDocId, doc);

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
        indexedAt: event.indexedAt,
      });
    } else if (event.partialFields) {
      // Partial fields originate from canonical search events. Explicitly strip
      // retired vector metadata so compatibility callers cannot reintroduce it.
      const partialFields = { ...event.partialFields } as Partial<PublicContentDocument>;
      delete partialFields.embedding;
      delete partialFields.sparseEmbedding;
      delete partialFields.embeddingStatus;
      delete partialFields.embeddingUpdatedAt;
      await this.osClient.upsert(event.stableDocId, {
        ...partialFields,
        indexedAt: event.indexedAt,
      });
    }
  }

  async onDelete(event: SearchPublicDeleteV1): Promise<void> {
    const resolvedId = await this.resolveDeleteStableDocId(event.stableDocId);

    if (event.deleteMode === 'hard') {
      await this.osClient.delete(resolvedId);
    } else {
      const existingDoc = await this.osClient.get(resolvedId);
      if (existingDoc) {
        await this.osClient.upsert(resolvedId, {
          isDeleted: true,
          indexedAt: new Date().toISOString(),
        });
      }
    }
  }

  async onDeleteByAuthor(event: SearchPublicDeleteByAuthorV1): Promise<void> {
    await this.osClient.deleteByAuthor(event.author);
  }

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
