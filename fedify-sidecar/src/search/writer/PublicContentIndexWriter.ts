/**
 * PublicContentIndexWriter
 * Consumes: search.public.upsert.v1, search.public.delete.v1
 * Writes: canonical Tier-3 public content projection.
 *
 * OS4b adds a conservative bulk fast path for fresh, unique full upserts. Any
 * existing document, duplicate target ID, merge case, delete, or partial update
 * stays on the original ordered path. Alias state is published only after the
 * corresponding OpenSearch write succeeds.
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

export interface BulkUpsertResult {
  ok: boolean;
  error?: unknown;
}

export interface PublicContentStore {
  get(id: string): Promise<PublicContentDocument | null>;
  upsert(id: string, doc: Partial<PublicContentDocument>): Promise<void>;
  getMany?(ids: string[]): Promise<Map<string, PublicContentDocument | null>>;
  upsertMany?(entries: Array<{ id: string; doc: Partial<PublicContentDocument> }>): Promise<BulkUpsertResult[]>;
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

export class PublicContentBatchError extends Error {
  constructor(
    message: string,
    readonly failedIndex: number,
    readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = 'PublicContentBatchError';
  }
}

export class PublicContentIndexWriter {
  constructor(
    private readonly osClient: PublicContentStore,
    private readonly aliasCache: SearchDocAliasCache,
    private readonly dedupService: SearchDedupService,
  ) {}

  async onUpsert(event: SearchPublicUpsertV1): Promise<void> {
    if (event.upsertKind === 'partial') return;

    const targetDocId = await this.dedupService.resolveStableDocId(event);
    const existingDoc = await this.osClient.get(targetDocId);

    if (existingDoc && existingDoc.sourceKind === 'remote' && event.sourceKind === 'remote') {
      const shouldMerge = await this.dedupService.shouldMergeRemoteDuplicate(existingDoc, event);
      if (!shouldMerge) {
        console.warn(`Skipping merge for remote duplicate: ${targetDocId}`);
        return;
      }
    }

    const doc = this.buildDocument(event, targetDocId, existingDoc);
    await this.osClient.upsert(targetDocId, doc);
    await this.publishAliases(event, targetDocId);
  }

  /**
   * Ordered bulk fast path used by OS4b.
   *
   * Fresh unique documents are grouped into `_bulk` requests. Existing IDs and
   * duplicate IDs stay sequential so merge/dedup semantics do not change. On a
   * partial bulk failure, aliases are published only for the successful prefix
   * and `failedIndex` identifies the first source event that must be replayed.
   */
  async onUpsertBatch(events: SearchPublicUpsertV1[]): Promise<void> {
    if (events.length <= 1 || !this.osClient.getMany || !this.osClient.upsertMany) {
      for (let i = 0; i < events.length; i++) {
        try {
          await this.onUpsert(events[i]!);
        } catch (error) {
          throw new PublicContentBatchError('Sequential upsert failed', i, error);
        }
      }
      return;
    }

    const targetIds: string[] = [];
    for (let i = 0; i < events.length; i++) {
      try {
        targetIds.push(await this.dedupService.resolveStableDocId(events[i]!));
      } catch (error) {
        throw new PublicContentBatchError('Stable document ID resolution failed', i, error);
      }
    }

    const counts = new Map<string, number>();
    for (const id of targetIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const uniqueFreshCandidates = targetIds.filter((id) => counts.get(id) === 1);

    let existingById: Map<string, PublicContentDocument | null>;
    try {
      existingById = await this.osClient.getMany(uniqueFreshCandidates);
    } catch (error) {
      throw new PublicContentBatchError('Bulk existence lookup failed', 0, error);
    }

    let i = 0;
    while (i < events.length) {
      const event = events[i]!;
      const targetId = targetIds[i]!;
      const mustStaySequential =
        event.upsertKind === 'partial' ||
        (counts.get(targetId) ?? 0) > 1 ||
        existingById.get(targetId) != null;

      if (mustStaySequential) {
        try {
          await this.onUpsert(event);
        } catch (error) {
          throw new PublicContentBatchError('Ordered fallback upsert failed', i, error);
        }
        i += 1;
        continue;
      }

      const start = i;
      const entries: Array<{ id: string; doc: Partial<PublicContentDocument> }> = [];
      while (i < events.length) {
        const candidate = events[i]!;
        const candidateId = targetIds[i]!;
        if (
          candidate.upsertKind === 'partial' ||
          (counts.get(candidateId) ?? 0) > 1 ||
          existingById.get(candidateId) != null
        ) break;
        entries.push({ id: candidateId, doc: this.buildDocument(candidate, candidateId, null) });
        i += 1;
      }

      let results: BulkUpsertResult[];
      try {
        results = await this.osClient.upsertMany(entries);
      } catch (error) {
        throw new PublicContentBatchError('OpenSearch bulk request failed', start, error);
      }
      if (results.length !== entries.length) {
        throw new PublicContentBatchError('OpenSearch bulk result cardinality mismatch', start);
      }

      for (let j = 0; j < entries.length; j++) {
        const sourceIndex = start + j;
        const result = results[j]!;
        if (!result.ok) {
          throw new PublicContentBatchError('OpenSearch bulk item failed', sourceIndex, result.error);
        }
        try {
          await this.publishAliases(events[sourceIndex]!, entries[j]!.id);
        } catch (error) {
          throw new PublicContentBatchError('Alias publication failed after bulk write', sourceIndex, error);
        }
      }
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

  private buildDocument(
    event: SearchPublicUpsertV1,
    targetDocId: string,
    existingDoc: PublicContentDocument | null,
  ): Partial<PublicContentDocument> {
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

    delete doc.embedding;
    delete doc.sparseEmbedding;
    delete doc.embeddingStatus;
    delete doc.embeddingUpdatedAt;

    if (!doc.protocolPresence) doc.protocolPresence = [];
    if (!doc.protocolPresence.includes(event.protocolSource)) doc.protocolPresence.push(event.protocolSource);
    if (event.ap) doc.ap = { ...doc.ap, ...event.ap };
    if (event.at) doc.at = { ...doc.at, ...event.at };
    if (!existingDoc) {
      doc.engagement = { likeCount: 0, repostCount: 0, replyCount: 0 };
    }
    return doc;
  }

  private async publishAliases(event: SearchPublicUpsertV1, targetDocId: string): Promise<void> {
    if (event.canonicalContentId) await this.aliasCache.setCanonicalId(event.canonicalContentId, targetDocId);
    if (event.ap?.objectUri) await this.aliasCache.setApUri(event.ap.objectUri, targetDocId);
    if (event.at?.uri) await this.aliasCache.setAtUri(event.at.uri, targetDocId);
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
