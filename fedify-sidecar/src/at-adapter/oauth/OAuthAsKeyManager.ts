import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import type { JWK, JWTPayload, KeyLike } from 'jose';

// Key material is stored in Redis encrypted with AES-256-GCM.
// The envelope key MUST be provided via OAUTH_AS_KEY_ENCRYPTION_KEY (64 hex chars = 32 bytes).
// Rotation: change the env var, delete the Redis key, restart — a new key pair is generated
// and re-encrypted under the new envelope key.
const KEY_ROTATION_DAYS = 90;
const KEY_TTL_SEC = KEY_ROTATION_DAYS * 24 * 60 * 60;

interface StoredAsKey {
  privateJwk: JWK;
  publicJwk: JWK;
  alg: 'ES256';
}

interface EncryptedBlob {
  v: 1;
  iv: string;   // hex
  tag: string;  // hex
  ct: string;   // hex (ciphertext)
}

function deriveEnvelopeKey(): Buffer {
  const raw = process.env['OAUTH_AS_KEY_ENCRYPTION_KEY'] ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'OAUTH_AS_KEY_ENCRYPTION_KEY must be set to exactly 64 hex characters (32 bytes). ' +
      'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(plaintext: string, envelopeKey: Buffer): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', envelopeKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), ct: ct.toString('hex') };
}

function decrypt(blob: EncryptedBlob, envelopeKey: Buffer): string {
  if (blob.v !== 1) throw new Error('oauth_as_key_unsupported_version');
  const iv = Buffer.from(blob.iv, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const ct = Buffer.from(blob.ct, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', envelopeKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}

export class OAuthAsKeyManager {
  constructor(
    private readonly redis: Redis,
    private readonly redisKey = 'at:oauth:as:key:p256',
  ) {}

  async initialize(): Promise<void> {
    const envelopeKey = deriveEnvelopeKey();
    const existing = await this.redis.get(this.redisKey);
    if (existing) {
      // Validate the stored blob is decryptable with the current envelope key
      // before declaring success — catches key rotation mismatches at startup.
      try {
        const blob = JSON.parse(existing) as EncryptedBlob;
        decrypt(blob, envelopeKey);
      } catch {
        throw new Error(
          'oauth_as_key_decryption_failed: stored key cannot be decrypted with current ' +
          'OAUTH_AS_KEY_ENCRYPTION_KEY. If you rotated the key, delete the Redis key ' +
          `"${this.redisKey}" and restart to regenerate.`,
        );
      }
      return;
    }

    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);

    const payload: StoredAsKey = { privateJwk, publicJwk, alg: 'ES256' };
    const blob = encrypt(JSON.stringify(payload), envelopeKey);

    // NX prevents a race between two startup instances both finding the key missing.
    const result = await this.redis.set(
      this.redisKey,
      JSON.stringify(blob),
      'EX', KEY_TTL_SEC,
      'NX',
    );
    if (result === null) {
      // Another instance won the race — verify their key is readable.
      await this.readStoredKey();
    }
  }

  private async readStoredKey(): Promise<StoredAsKey> {
    const envelopeKey = deriveEnvelopeKey();
    const raw = await this.redis.get(this.redisKey);
    if (!raw) throw new Error('oauth_as_key_missing');

    let blob: EncryptedBlob;
    try {
      blob = JSON.parse(raw) as EncryptedBlob;
    } catch {
      throw new Error('oauth_as_key_corrupted');
    }

    const plaintext = decrypt(blob, envelopeKey);
    const parsed = JSON.parse(plaintext) as StoredAsKey;
    if (parsed.alg !== 'ES256') throw new Error('oauth_as_key_invalid_alg');
    return parsed;
  }

  async getPrivateKey(): Promise<KeyLike | Uint8Array> {
    const stored = await this.readStoredKey();
    return importJWK(stored.privateJwk, 'ES256');
  }

  async getPublicJwk(): Promise<JWK> {
    const stored = await this.readStoredKey();
    return stored.publicJwk;
  }

  async signJwt(
    payload: JWTPayload,
    issuer: string,
    audience: string,
    subject: string,
    jti: string,
    expiresInSec: number,
  ): Promise<string> {
    const privateKey = await this.getPrivateKey();
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${expiresInSec}s`)
      .sign(privateKey);
  }
}
