/**
 * V6.5 Phase 5: Blob Reference Mapper
 *
 * Maps stored blob metadata to ATProto blob references.
 */

import { AtBlobRef, StoredBlobMetadata } from './AtBlobStore';

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
