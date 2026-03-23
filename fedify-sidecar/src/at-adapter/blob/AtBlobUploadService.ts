/**
 * V6.5 Phase 5: AT Blob Upload Service
 *
 * Handles uploading canonical media bytes to the AT blob store.
 */

import { AtBlobRef, AtBlobStore } from './AtBlobStore';
import { BlobReferenceMapper } from './BlobReferenceMapper';

export interface AtBlobUploadService {
  ensureImageBlob(input: {
    did: string;
    mediaId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AtBlobRef>;
}

export class DefaultAtBlobUploadService implements AtBlobUploadService {
  constructor(
    private readonly blobStore: AtBlobStore,
    private readonly blobMapper: BlobReferenceMapper
  ) {}

  async ensureImageBlob(input: {
    did: string;
    mediaId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AtBlobRef> {
    // 1. Validate mime type (images only for Phase 5)
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`Unsupported blob mime type: ${input.mimeType}. Only images are supported in Phase 5.`);
    }

    // 2. Store blob
    const meta = await this.blobStore.putBlob(input.did, input.bytes, input.mimeType);

    // 3. Map to AT blob ref
    return this.blobMapper.toAtBlobRef(meta);
  }
}
