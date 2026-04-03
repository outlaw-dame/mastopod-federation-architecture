/**
 * V6.5 Phase 5: Blob Reference Mapper
 *
 * Maps stored blob metadata to ATProto blob references.
 */

import type { AtBlobRef, StoredBlobMetadata } from './AtBlobStore.js';

export interface BlobReferenceMapper {
  toAtBlobRef(meta: StoredBlobMetadata): AtBlobRef;
}

export class DefaultBlobReferenceMapper implements BlobReferenceMapper {
  toAtBlobRef(meta: StoredBlobMetadata): AtBlobRef {
    return {
      $type: 'blob',
      ref: { $link: meta.cid },
      mimeType: meta.mimeType,
      size: meta.size
    };
  }
}
