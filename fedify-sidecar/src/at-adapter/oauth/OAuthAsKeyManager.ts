import type { Redis } from 'ioredis';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import type { JWK, JWTPayload, KeyLike } from 'jose';

interface StoredAsKey {
  privateJwk: JWK;
  publicJwk: JWK;
  alg: 'ES256';
}

export class OAuthAsKeyManager {
  constructor(
    private readonly redis: Redis,
    private readonly redisKey = 'at:oauth:as:key:p256',
  ) {}

  async initialize(): Promise<void> {
    const current = await this.redis.get(this.redisKey);
    if (current) {
      return;
    }

    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);

    const payload: StoredAsKey = {
      privateJwk,
      publicJwk,
      alg: 'ES256',
    };

    await this.redis.set(this.redisKey, JSON.stringify(payload));
  }

  private async readStoredKey(): Promise<StoredAsKey> {
    const raw = await this.redis.get(this.redisKey);
    if (!raw) {
      throw new Error('oauth_as_key_missing');
    }

    const parsed = JSON.parse(raw) as StoredAsKey;
    if (parsed.alg !== 'ES256') {
      throw new Error('oauth_as_key_invalid_alg');
    }
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
