import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export interface StoredExternalAtSession {
  canonicalAccountId: string;
  did: string;
  handle: string;
  pdsUrl: string;
  accessJwt: string;
  refreshJwt?: string;
  createdAt: string;
  refreshedAt?: string;
  accessTokenId?: string;
  refreshTokenId?: string;
}

export interface ExternalAtSessionStore {
  put(sessionKey: string, value: StoredExternalAtSession): Promise<void>;
  get(sessionKey: string): Promise<StoredExternalAtSession | null>;
  delete(sessionKey: string): Promise<void>;
}

interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export class RedisExternalAtSessionStore implements ExternalAtSessionStore {
  private readonly ttlSeconds: number;
  private readonly encryptionKey: Buffer;
  private readonly keyVersion: string;

  constructor(
    private readonly redis: RedisLike,
    encryptionKeyHex: string,
    ttlSeconds: number = 60 * 60 * 12,
    keyVersion: string = 'v1'
  ) {
    this.ttlSeconds = clampTtl(ttlSeconds);
    this.encryptionKey = deriveEncryptionKey(encryptionKeyHex);
    this.keyVersion = keyVersion.trim() || 'v1';
  }

  async put(sessionKey: string, value: StoredExternalAtSession): Promise<void> {
    const key = this.key(sessionKey);
    const payload = JSON.stringify(value);
    const encrypted = this.encrypt(payload, value);
    await this.redis.set(
      key,
      JSON.stringify({
        v: this.keyVersion,
        aad: makeAad(value),
        ciphertext: encrypted,
      }),
      'EX',
      this.ttlSeconds
    );
  }

  async get(sessionKey: string): Promise<StoredExternalAtSession | null> {
    const key = this.key(sessionKey);
    const encrypted = await this.redis.get(key);
    if (!encrypted) return null;

    try {
      const plaintext = this.decrypt(encrypted);
      return JSON.parse(plaintext) as StoredExternalAtSession;
    } catch {
      await this.redis.del(key);
      return null;
    }
  }

  async delete(sessionKey: string): Promise<void> {
    await this.redis.del(this.key(sessionKey));
  }

  private key(sessionKey: string): string {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      throw new Error('External AT session key is required');
    }
    return `at:external:session:${trimmed}`;
  }

  private encrypt(plaintext: string, session: StoredExternalAtSession): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(makeAad(session)), 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
  }

  private decrypt(encoded: string): string {
    if (encoded.startsWith('{')) {
      const envelope = JSON.parse(encoded) as {
        v?: string;
        aad?: Record<string, string>;
        ciphertext?: string;
      };

      if (!envelope.ciphertext || !envelope.aad) {
        throw new Error('Encrypted external session envelope is malformed');
      }

      return this.decryptCiphertext(envelope.ciphertext, envelope.aad);
    }

    return this.decryptLegacy(encoded);
  }

  private decryptCiphertext(encoded: string, aad: Record<string, string>): string {
    const payload = Buffer.from(encoded, 'base64url');
    if (payload.length <= 28) {
      throw new Error('Encrypted external session payload is malformed');
    }

    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(aad), 'utf8'));
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  private decryptLegacy(encoded: string): string {
    const payload = Buffer.from(encoded, 'base64url');
    if (payload.length <= 28) {
      throw new Error('Encrypted external session payload is malformed');
    }

    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}

function deriveEncryptionKey(encryptionKeyHex: string): Buffer {
  const trimmed = encryptionKeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(trimmed) || trimmed.length < 64 || trimmed.length % 2 !== 0) {
    throw new Error(
      'EXTERNAL_AT_SESSION_KEY_HEX must be an even-length hex string with at least 64 characters'
    );
  }

  return createHash('sha256')
    .update(Buffer.from(trimmed, 'hex'))
    .digest();
}

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return 60 * 60 * 12;
  return Math.min(60 * 60 * 24 * 7, Math.max(60, Math.trunc(ttlSeconds)));
}

function makeAad(session: Pick<StoredExternalAtSession, 'canonicalAccountId' | 'did' | 'pdsUrl'>): Record<string, string> {
  return {
    canonicalAccountId: session.canonicalAccountId,
    did: session.did,
    pdsUrl: session.pdsUrl,
  };
}
