import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type {
  OAuthAuthorizationCodeRecord,
  OAuthDpopNonceRecord,
  OAuthGrantRecord,
  OAuthParStoredRequest,
  OAuthRefreshTokenRecord,
} from './OAuthTypes.js';

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class OAuthParStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'at:oauth:par',
  ) {}

  async put(record: OAuthParStoredRequest): Promise<void> {
    const ttlSec = Math.max(1, record.expiresAtEpochSec - Math.floor(Date.now() / 1000));
    await this.redis.set(`${this.keyPrefix}:${record.requestUri}`, JSON.stringify(record), 'EX', ttlSec);
  }

  async get(requestUri: string): Promise<OAuthParStoredRequest | null> {
    return parseJson<OAuthParStoredRequest>(await this.redis.get(`${this.keyPrefix}:${requestUri}`));
  }

  async consume(requestUri: string): Promise<OAuthParStoredRequest | null> {
    const key = `${this.keyPrefix}:${requestUri}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    await this.redis.del(key);
    return parseJson<OAuthParStoredRequest>(raw);
  }
}

export class OAuthAuthorizationCodeStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'at:oauth:code',
  ) {}

  async put(record: OAuthAuthorizationCodeRecord): Promise<void> {
    const ttlSec = Math.max(1, record.expiresAtEpochSec - Math.floor(Date.now() / 1000));
    await this.redis.set(`${this.keyPrefix}:${record.code}`, JSON.stringify(record), 'EX', ttlSec);
  }

  async consume(code: string): Promise<OAuthAuthorizationCodeRecord | null> {
    const key = `${this.keyPrefix}:${code}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    await this.redis.del(key);
    return parseJson<OAuthAuthorizationCodeRecord>(raw);
  }
}

export class OAuthGrantStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'at:oauth:grant',
  ) {}

  async put(record: OAuthGrantRecord): Promise<void> {
    await this.redis.set(`${this.keyPrefix}:${record.grantId}`, JSON.stringify(record));
  }

  async get(grantId: string): Promise<OAuthGrantRecord | null> {
    return parseJson<OAuthGrantRecord>(await this.redis.get(`${this.keyPrefix}:${grantId}`));
  }

  async createOrUpdate(input: Omit<OAuthGrantRecord, 'grantId' | 'createdAtEpochSec' | 'updatedAtEpochSec'>): Promise<OAuthGrantRecord> {
    const now = Math.floor(Date.now() / 1000);
    const grantId = randomUUID();
    const record: OAuthGrantRecord = {
      grantId,
      createdAtEpochSec: now,
      updatedAtEpochSec: now,
      ...input,
    };
    await this.put(record);
    return record;
  }
}

export class OAuthRefreshTokenStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'at:oauth:refresh',
    private readonly familyPrefix = 'at:oauth:refresh-family',
  ) {}

  async put(record: OAuthRefreshTokenRecord): Promise<void> {
    const ttlSec = Math.max(1, record.expiresAtEpochSec - Math.floor(Date.now() / 1000));
    const key = `${this.keyPrefix}:${record.refreshTokenId}`;
    const familyKey = `${this.familyPrefix}:${record.familyId}`;
    await this.redis.multi()
      .set(key, JSON.stringify(record), 'EX', ttlSec)
      .sadd(familyKey, key)
      .expire(familyKey, ttlSec)
      .exec();
  }

  async get(tokenId: string): Promise<OAuthRefreshTokenRecord | null> {
    return parseJson<OAuthRefreshTokenRecord>(await this.redis.get(`${this.keyPrefix}:${tokenId}`));
  }

  async revoke(tokenId: string, revokedAtEpochSec: number, replacedByTokenId?: string): Promise<void> {
    const key = `${this.keyPrefix}:${tokenId}`;
    const current = await this.get(tokenId);
    if (!current) return;
    const next: OAuthRefreshTokenRecord = {
      ...current,
      revokedAtEpochSec,
      replacedByTokenId,
    };
    const ttlSec = Math.max(1, next.expiresAtEpochSec - Math.floor(Date.now() / 1000));
    await this.redis.set(key, JSON.stringify(next), 'EX', ttlSec);
  }

  async revokeFamily(familyId: string, revokedAtEpochSec: number): Promise<void> {
    const familyKey = `${this.familyPrefix}:${familyId}`;
    const tokenKeys = await this.redis.smembers(familyKey);
    if (!tokenKeys.length) return;

    for (const tokenKey of tokenKeys) {
      const raw = await this.redis.get(tokenKey);
      const parsed = parseJson<OAuthRefreshTokenRecord>(raw);
      if (!parsed) continue;
      const ttlSec = Math.max(1, parsed.expiresAtEpochSec - Math.floor(Date.now() / 1000));
      await this.redis.set(
        tokenKey,
        JSON.stringify({ ...parsed, revokedAtEpochSec }),
        'EX',
        ttlSec,
      );
    }
  }
}

export class OAuthDpopNonceStore {
  constructor(
    private readonly redis: Redis,
    private readonly noncePrefix = 'at:oauth:dpop:nonce',
    private readonly replayPrefix = 'at:oauth:dpop:proof-jti',
  ) {}

  async mintNonce(ttlSec: number): Promise<OAuthDpopNonceRecord> {
    const nonce = randomUUID();
    const expiresAtEpochSec = Math.floor(Date.now() / 1000) + ttlSec;
    await this.redis.set(`${this.noncePrefix}:${nonce}`, '1', 'EX', ttlSec);
    return { nonce, expiresAtEpochSec };
  }

  async verifyNonce(nonce: string): Promise<boolean> {
    const exists = await this.redis.exists(`${this.noncePrefix}:${nonce}`);
    return exists === 1;
  }

  async rememberProofJti(jkt: string, jti: string, ttlSec: number): Promise<boolean> {
    const key = `${this.replayPrefix}:${jkt}:${jti}`;
    const result = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
    return result === 'OK';
  }
}

export interface OAuthConsentChallengeRecord {
  challengeId: string;
  requestUri: string;
  fingerprint: string;
  createdAtEpochSec: number;
  expiresAtEpochSec: number;
}

export class OAuthConsentChallengeStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'at:oauth:consent-challenge',
  ) {}

  async mint(requestUri: string, fingerprint: string, ttlSec: number): Promise<OAuthConsentChallengeRecord> {
    const challengeId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const record: OAuthConsentChallengeRecord = {
      challengeId,
      requestUri,
      fingerprint,
      createdAtEpochSec: now,
      expiresAtEpochSec: now + ttlSec,
    };

    await this.redis.set(
      `${this.keyPrefix}:${challengeId}`,
      JSON.stringify(record),
      'EX',
      Math.max(1, ttlSec),
    );

    return record;
  }

  async consume(challengeId: string): Promise<OAuthConsentChallengeRecord | null> {
    const key = `${this.keyPrefix}:${challengeId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    await this.redis.del(key);
    return parseJson<OAuthConsentChallengeRecord>(raw);
  }
}

export interface OAuthRateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetAtEpochSec: number;
}

export class OAuthRateLimitStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'at:oauth:ratelimit',
    private readonly maxAttempts = 3,
    private readonly baseDelayMs = 25,
    private readonly maxDelayMs = 250,
  ) {}

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableRedisError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout')
      || message.includes('connection')
      || message.includes('socket')
      || message.includes('econnreset')
      || message.includes('econnrefused')
      || message.includes('clusterdown')
      || message.includes('try again')
    );
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        if (attempt >= this.maxAttempts || !this.isRetryableRedisError(error)) {
          throw error;
        }
        const exp = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** (attempt - 1)));
        const waitMs = Math.floor(Math.random() * exp);
        await this.delay(waitMs);
      }
    }
  }

  async consume(key: string, limit: number, windowSec: number): Promise<OAuthRateLimitResult> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeWindowSec = Math.max(1, Math.floor(windowSec));
    const redisKey = `${this.keyPrefix}:${key}`;
    const count = await this.withRetry(() => this.redis.incr(redisKey));

    let ttl = await this.withRetry(() => this.redis.ttl(redisKey));
    if (count === 1 || ttl < 0) {
      await this.withRetry(() => this.redis.expire(redisKey, safeWindowSec));
      ttl = safeWindowSec;
    }

    const now = Math.floor(Date.now() / 1000);
    const retryAfterSec = Math.max(1, ttl);
    const allowed = count <= safeLimit;

    return {
      allowed,
      count,
      limit: safeLimit,
      remaining: Math.max(0, safeLimit - count),
      retryAfterSec,
      resetAtEpochSec: now + retryAfterSec,
    };
  }
}
