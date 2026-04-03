/**
 * V6.5 Phase 5: AT Blob Upload Service
 *
 * Handles uploading canonical media bytes to the AT blob store.
 */

import type { AtBlobRef, AtBlobStore } from './AtBlobStore.js';
import type { BlobReferenceMapper } from './BlobReferenceMapper.js';

export interface AtBlobUploadService {
  ensureBlob(input: {
    did: string;
    mediaId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AtBlobRef>;
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

  async ensureBlob(input: {
    did: string;
    mediaId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AtBlobRef> {
    if (
      !input.mimeType.startsWith('image/') &&
      !input.mimeType.startsWith('video/') &&
      !input.mimeType.startsWith('audio/')
    ) {
      throw new Error(`Unsupported blob mime type: ${input.mimeType}. Only image, video, and audio blobs are supported.`);
    }

    // 2. Store blob
    const meta = await this.blobStore.putBlob(input.did, input.bytes, input.mimeType);

    // 3. Map to AT blob ref
    return this.blobMapper.toAtBlobRef(meta);
  }

  async ensureImageBlob(input: {
    did: string;
    mediaId: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AtBlobRef> {
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`Unsupported blob mime type: ${input.mimeType}. Only images are supported for ensureImageBlob.`);
    }

    return this.ensureBlob(input);
  }
}
