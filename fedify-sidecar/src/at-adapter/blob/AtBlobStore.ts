/**
 * V6.5 Phase 5: AT Blob Store
 *
 * Manages storage and retrieval of blobs (images) in the context of an account DID.
 */

import { createHash } from 'node:crypto';

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
  getBlobMetadata(did: string, cid: string): Promise<StoredBlobMetadata | null>;
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

  async getBlobMetadata(did: string, cid: string): Promise<StoredBlobMetadata | null> {
    const key = `${did}:${cid}`;
    const entry = this.blobs.get(key);
    return entry ? entry.meta : null;
  }
}

type RedisLike = {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

type RedisBlobRecord = {
  did: string;
  cid: string;
  mimeType: string;
  size: number;
  createdAt: string;
  bytesBase64: string;
};

export class RedisAtBlobStore implements AtBlobStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly keyPrefix = 'at:blob'
  ) {}

  async putBlob(did: string, bytes: Uint8Array, mimeType: string): Promise<StoredBlobMetadata> {
    const cid = this.generateCid(bytes);
    const createdAt = new Date().toISOString();
    const bytesBase64 = Buffer.from(bytes).toString('base64');

    const record: RedisBlobRecord = {
      did,
      cid,
      mimeType,
      size: bytes.length,
      createdAt,
      bytesBase64,
    };

    await this.redis.set(this.buildKey(did, cid), JSON.stringify(record));

    return {
      did,
      cid,
      mimeType,
      size: bytes.length,
      createdAt,
    };
  }

  async getBlob(did: string, cid: string): Promise<Uint8Array | null> {
    const record = await this.getRecord(did, cid);
    if (!record) {
      return null;
    }

    return Uint8Array.from(Buffer.from(record.bytesBase64, 'base64'));
  }

  async getBlobMetadata(did: string, cid: string): Promise<StoredBlobMetadata | null> {
    const record = await this.getRecord(did, cid);
    if (!record) {
      return null;
    }

    return {
      did: record.did,
      cid: record.cid,
      mimeType: record.mimeType,
      size: record.size,
      createdAt: record.createdAt,
    };
  }

  private buildKey(did: string, cid: string): string {
    return `${this.keyPrefix}:${did}:${cid}`;
  }

  private generateCid(bytes: Uint8Array): string {
    const digest = createHash('sha256').update(bytes).digest('hex');
    return `bafkrei${digest.slice(0, 48)}`;
  }

  private async getRecord(did: string, cid: string): Promise<RedisBlobRecord | null> {
    const raw = await this.redis.get(this.buildKey(did, cid));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<RedisBlobRecord>;
      if (
        typeof parsed.did !== 'string' ||
        typeof parsed.cid !== 'string' ||
        typeof parsed.mimeType !== 'string' ||
        typeof parsed.size !== 'number' ||
        typeof parsed.createdAt !== 'string' ||
        typeof parsed.bytesBase64 !== 'string'
      ) {
        return null;
      }

      return parsed as RedisBlobRecord;
    } catch {
      return null;
    }
  }
}
