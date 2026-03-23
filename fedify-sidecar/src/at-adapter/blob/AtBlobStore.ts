/**
 * V6.5 Phase 5: AT Blob Store
 *
 * Manages storage and retrieval of blobs (images) in the context of an account DID.
 */

export interface AtBlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface StoredBlobMetadata {
  did: string;
  cid: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface AtBlobStore {
  putBlob(did: string, bytes: Uint8Array, mimeType: string): Promise<StoredBlobMetadata>;
  getBlob(did: string, cid: string): Promise<Uint8Array | null>;
}

export class DefaultAtBlobStore implements AtBlobStore {
  // In a real implementation, this would use S3 or local disk
  // For Phase 5, we use an in-memory map for testing
  private blobs = new Map<string, { bytes: Uint8Array; meta: StoredBlobMetadata }>();

  async putBlob(did: string, bytes: Uint8Array, mimeType: string): Promise<StoredBlobMetadata> {
    // In a real implementation, we would compute the actual CID using multiformats
    // For Phase 5, we generate a mock CID
    const cid = 'bafkreimockblobcid' + Date.now() + Math.floor(Math.random() * 1000);
    
    const meta: StoredBlobMetadata = {
      did,
      cid,
      mimeType,
      size: bytes.length,
      createdAt: new Date().toISOString()
    };

    const key = `${did}:${cid}`;
    this.blobs.set(key, { bytes, meta });

    return meta;
  }

  async getBlob(did: string, cid: string): Promise<Uint8Array | null> {
    const key = `${did}:${cid}`;
    const entry = this.blobs.get(key);
    return entry ? entry.bytes : null;
  }
}
