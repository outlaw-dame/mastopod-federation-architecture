/**
 * V6.5 Phase 5.5: Unified OpenSearch Read Stack
 *
 * PublicAuthorIndexWriter
 * Writes to the public-author-v1 index.
 */

import { SearchAuthorUpsertV1, SearchAuthorDeleteV1 } from '../events/SearchEvents.js';
import { PublicAuthorDocument } from '../models/PublicAuthorDocument.js';

export interface PublicAuthorStore {
  get(id: string): Promise<PublicAuthorDocument | null>;
  upsert(id: string, doc: Partial<PublicAuthorDocument>): Promise<void>;
  delete(id: string): Promise<void>;
}

export type OpenSearchAuthorClient = PublicAuthorStore;

export class PublicAuthorIndexWriter {
  constructor(private readonly osClient: PublicAuthorStore) {}

  async onUpsert(event: SearchAuthorUpsertV1): Promise<void> {
    const targetId = event.stableAuthorId;
    const existingDoc = await this.osClient.get(targetId);

    const doc: Partial<PublicAuthorDocument> = existingDoc ? { ...existingDoc } : {
      stableAuthorId: targetId,
      canonicalAccountId: event.canonicalAccountId,
      protocolPresence: [],
      sourceKind: event.sourceKind,
      updatedAt: event.updatedAt
    };

    // Add protocol presence
    if (!doc.protocolPresence!.includes(event.protocolSource)) {
      doc.protocolPresence!.push(event.protocolSource);
    }

    // Update fields
    if (event.apUri) doc.apUri = event.apUri;
    if (event.did) doc.did = event.did;
    if (event.handle) doc.handle = event.handle;
    if (event.displayName) doc.displayName = event.displayName;
    if (event.summaryText) doc.summaryText = event.summaryText;
    if (event.labels) doc.labels = event.labels;
    if (event.langs) doc.langs = event.langs;
    if (event.searchConsent) {
      doc.searchConsentPublic = event.searchConsent.publicSearchable;
      doc.searchConsentExplicit = event.searchConsent.explicitlySet;
      doc.searchConsentSource = event.searchConsent.source;
      doc.searchableBy = event.searchConsent.searchableBy;
      doc.indexable =
        typeof event.searchConsent.indexable === "boolean" ? event.searchConsent.indexable : undefined;
    }
    
    doc.updatedAt = event.updatedAt;

    await this.osClient.upsert(targetId, doc);
  }

  async onDelete(event: SearchAuthorDeleteV1): Promise<void> {
    if (event.deleteMode === 'hard') {
      await this.osClient.delete(event.stableAuthorId);
    } else {
      // Soft delete for authors might just mean clearing profile fields or adding a label
      // For now, we'll just update the timestamp to reflect the tombstone
      await this.osClient.upsert(event.stableAuthorId, {
        updatedAt: event.deletedAt,
        labels: ['deleted']
      });
    }
  }
}
