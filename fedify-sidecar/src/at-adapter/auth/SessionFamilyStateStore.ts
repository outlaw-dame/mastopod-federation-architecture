import { randomUUID } from 'node:crypto';
import type { AtSessionContext } from './AtSessionTypes.js';

export interface SessionFamilyRecord {
  familyId: string;
  canonicalAccountId: string;
  did: string;
  handle: string;
  scope: AtSessionContext['scope'];
  status: 'active' | 'revoked' | 'compromised';
  currentRefreshTokenId: string;
  previousRefreshTokenId?: string;
  createdAt: string;
  updatedAt: string;
}

export type RotateFamilyResult =
  | { kind: 'rotated'; family: SessionFamilyRecord }
  | { kind: 'missing' }
  | { kind: 'inactive'; family: SessionFamilyRecord }
  | { kind: 'replay'; family: SessionFamilyRecord };

export interface SessionFamilyStateStore {
  createFamily(record: SessionFamilyRecord, ttlSeconds: number): Promise<void>;
  getFamily(familyId: string): Promise<SessionFamilyRecord | null>;
  markFamilyCompromised(familyId: string, ttlSeconds: number): Promise<void>;
  rotateFamily(
    familyId: string,
    presentedRefreshTokenId: string,
    nextRefreshTokenId: string,
    ttlSeconds: number
  ): Promise<RotateFamilyResult>;
  revokeFamilyByRefreshTokenId(refreshTokenId: string, ttlSeconds: number): Promise<void>;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval?(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export class InMemorySessionFamilyStateStore implements SessionFamilyStateStore {
  private readonly families = new Map<string, SessionFamilyRecord>();
  private readonly refreshToFamily = new Map<string, string>();

  async createFamily(record: SessionFamilyRecord, _ttlSeconds: number): Promise<void> {
    this.families.set(record.familyId, cloneRecord(record));
    this.refreshToFamily.set(record.currentRefreshTokenId, record.familyId);
  }

  async getFamily(familyId: string): Promise<SessionFamilyRecord | null> {
    return cloneRecord(this.families.get(familyId) ?? null);
  }

  async markFamilyCompromised(familyId: string, _ttlSeconds: number): Promise<void> {
    const family = this.families.get(familyId);
    if (!family) return;

    family.status = 'compromised';
    family.updatedAt = new Date().toISOString();
    this.families.set(family.familyId, cloneRecord(family)!);
  }

  async rotateFamily(
    familyId: string,
    presentedRefreshTokenId: string,
    nextRefreshTokenId: string
  ): Promise<RotateFamilyResult> {
    const family = this.families.get(familyId);
    if (!family) {
      return { kind: 'missing' };
    }

    if (family.status !== 'active') {
      return { kind: 'inactive', family: cloneRecord(family)! };
    }

    if (family.currentRefreshTokenId !== presentedRefreshTokenId) {
      family.status = 'compromised';
      family.updatedAt = new Date().toISOString();
      this.families.set(family.familyId, cloneRecord(family)!);
      return { kind: 'replay', family: cloneRecord(family)! };
    }

    family.previousRefreshTokenId = presentedRefreshTokenId;
    family.currentRefreshTokenId = nextRefreshTokenId;
    family.updatedAt = new Date().toISOString();
    this.families.set(family.familyId, cloneRecord(family)!);
    this.refreshToFamily.set(nextRefreshTokenId, familyId);
    return { kind: 'rotated', family: cloneRecord(family)! };
  }

  async revokeFamilyByRefreshTokenId(
    refreshTokenId: string,
    _ttlSeconds: number
  ): Promise<void> {
    const familyId = this.refreshToFamily.get(refreshTokenId);
    if (!familyId) return;

    const family = this.families.get(familyId);
    if (!family) return;

    family.status = 'revoked';
    family.updatedAt = new Date().toISOString();
    this.families.set(family.familyId, cloneRecord(family)!);
  }
}

export class RedisSessionFamilyStateStore implements SessionFamilyStateStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly keyPrefix = 'at:session',
    private readonly lockTtlMs = 5_000
  ) {}

  async createFamily(record: SessionFamilyRecord, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(record);
    await this.redis.set(this.familyKey(record.familyId), serialized, 'EX', ttlSeconds);
    await this.redis.set(
      this.refreshIndexKey(record.currentRefreshTokenId),
      record.familyId,
      'EX',
      ttlSeconds
    );
  }

  async getFamily(familyId: string): Promise<SessionFamilyRecord | null> {
    const raw = await this.redis.get(this.familyKey(familyId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionFamilyRecord;
  }

  async markFamilyCompromised(familyId: string, ttlSeconds: number): Promise<void> {
    await this.withFamilyLock(familyId, async () => {
      const family = await this.getFamily(familyId);
      if (!family) return;

      const compromised: SessionFamilyRecord = {
        ...family,
        status: 'compromised',
        updatedAt: new Date().toISOString(),
      };
      await this.redis.set(
        this.familyKey(familyId),
        JSON.stringify(compromised),
        'EX',
        ttlSeconds
      );
    });
  }

  async rotateFamily(
    familyId: string,
    presentedRefreshTokenId: string,
    nextRefreshTokenId: string,
    ttlSeconds: number
  ): Promise<RotateFamilyResult> {
    return this.withFamilyLock(familyId, async () => {
      const family = await this.getFamily(familyId);
      if (!family) {
        return { kind: 'missing' } satisfies RotateFamilyResult;
      }

      if (family.status !== 'active') {
        return { kind: 'inactive', family } satisfies RotateFamilyResult;
      }

      if (family.currentRefreshTokenId !== presentedRefreshTokenId) {
        const compromised: SessionFamilyRecord = {
          ...family,
          status: 'compromised',
          updatedAt: new Date().toISOString(),
        };
        await this.redis.set(this.familyKey(familyId), JSON.stringify(compromised), 'EX', ttlSeconds);
        return { kind: 'replay', family: compromised } satisfies RotateFamilyResult;
      }

      const rotated: SessionFamilyRecord = {
        ...family,
        previousRefreshTokenId: presentedRefreshTokenId,
        currentRefreshTokenId: nextRefreshTokenId,
        updatedAt: new Date().toISOString(),
      };

      await this.redis.set(this.familyKey(familyId), JSON.stringify(rotated), 'EX', ttlSeconds);
      await this.redis.set(this.refreshIndexKey(nextRefreshTokenId), familyId, 'EX', ttlSeconds);
      return { kind: 'rotated', family: rotated } satisfies RotateFamilyResult;
    });
  }

  async revokeFamilyByRefreshTokenId(refreshTokenId: string, ttlSeconds: number): Promise<void> {
    const familyId = await this.redis.get(this.refreshIndexKey(refreshTokenId));
    if (!familyId) return;

    await this.withFamilyLock(familyId, async () => {
      const family = await this.getFamily(familyId);
      if (!family) return;
      const revoked: SessionFamilyRecord = {
        ...family,
        status: 'revoked',
        updatedAt: new Date().toISOString(),
      };
      await this.redis.set(this.familyKey(familyId), JSON.stringify(revoked), 'EX', ttlSeconds);
    });
  }

  private async withFamilyLock<T>(familyId: string, fn: () => Promise<T>): Promise<T> {
    const lockValue = randomUUID();
    const lockKey = this.familyLockKey(familyId);
    const acquired = await this.redis.set(
      lockKey,
      lockValue,
      'PX',
      this.lockTtlMs,
      'NX'
    );

    if (acquired !== 'OK') {
      throw new Error('SESSION_FAMILY_LOCKED');
    }

    try {
      return await fn();
    } finally {
      await this.releaseFamilyLock(lockKey, lockValue);
    }
  }

  private async releaseFamilyLock(lockKey: string, lockValue: string): Promise<void> {
    if (typeof this.redis.eval === 'function') {
      await this.redis.eval(
        `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          end
          return 0
        `,
        1,
        lockKey,
        lockValue
      );
      return;
    }

    const current = await this.redis.get(lockKey);
    if (current === lockValue) {
      await this.redis.del(lockKey);
    }
  }

  private familyKey(familyId: string): string {
    return `${this.keyPrefix}:family:${familyId}`;
  }

  private familyLockKey(familyId: string): string {
    return `${this.keyPrefix}:family-lock:${familyId}`;
  }

  private refreshIndexKey(refreshTokenId: string): string {
    return `${this.keyPrefix}:refresh:${refreshTokenId}`;
  }
}

function cloneRecord(record: SessionFamilyRecord | null): SessionFamilyRecord | null {
  if (!record) return null;
  return { ...record };
}
