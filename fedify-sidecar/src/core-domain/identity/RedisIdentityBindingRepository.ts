/**
 * Redis-backed Identity Binding Repository
 *
 * Storage layout (all keys namespaced under `identity:`):
 *   identity:binding:{canonicalAccountId}  →  JSON(IdentityBinding)
 *   identity:idx:did:{did}                 →  canonicalAccountId
 *   identity:idx:handle:{handle}           →  canonicalAccountId
 *   identity:idx:actor:{actorUri}          →  canonicalAccountId
 *   identity:idx:webid:{webId}             →  canonicalAccountId
 *   identity:all                           →  Set<canonicalAccountId>
 *
 * Individual binding/index write groups use Redis MULTI. The repository-level
 * transaction(callback) helper remains callback-scoped rather than a Redis
 * transaction spanning arbitrary asynchronous repository calls.
 */

import { randomUUID } from 'node:crypto';
import {
  IdentityBindingRepository,
  RepositoryError,
  RepositoryErrorCode,
} from './IdentityBindingRepository.js';
import { IdentityBinding } from './IdentityBinding.js';

const PREFIX     = 'identity:binding:';
const IDX_DID    = 'identity:idx:did:';
const IDX_HANDLE = 'identity:idx:handle:';
const IDX_ACTOR  = 'identity:idx:actor:';
const IDX_WEBID  = 'identity:idx:webid:';
const ALL_SET    = 'identity:all';
const SCAN_COUNT = 128;
const MGET_BATCH = 128;
const SCAN_SESSION_PREFIX = 'identity:scan:seen:';
const SCAN_SESSION_SENTINEL = '\u0000identity-scan-session';
const SCAN_SESSION_TTL_MS = 5 * 60_000;

const OPEN_SCAN_SESSION_LUA = `
local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return redis.error_reply('IDENTITY_SCAN_SESSION_INVALID_TTL')
end

redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('PEXPIRE', KEYS[1], ttl) ~= 1 then
  return redis.error_reply('IDENTITY_SCAN_SESSION_TTL_FAILED')
end
return 1
`;

const DEDUPE_SCAN_IDS_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) ~= 1 then
  return redis.error_reply('IDENTITY_SCAN_SESSION_EXPIRED')
end

local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return redis.error_reply('IDENTITY_SCAN_SESSION_INVALID_TTL')
end

local fresh = {}
for i = 3, #ARGV do
  if redis.call('SADD', KEYS[1], ARGV[i]) == 1 then
    table.insert(fresh, ARGV[i])
  end
end
redis.call('PEXPIRE', KEYS[1], ttl)
return fresh
`;

export class RedisIdentityBindingRepository implements IdentityBindingRepository {
  constructor(private readonly redis: any) {}

  async getByCanonicalAccountId(canonicalAccountId: string): Promise<IdentityBinding | null> {
    const raw = await this.redis.get(this.bindingKey(canonicalAccountId));
    return raw ? (JSON.parse(raw) as IdentityBinding) : null;
  }

  async getByAtprotoDid(did: string): Promise<IdentityBinding | null> {
    const canonicalAccountId = await this.redis.get(this.didIndexKey(did));
    if (!canonicalAccountId) return null;
    return this.getByCanonicalAccountId(canonicalAccountId);
  }

  async getByDid(did: string): Promise<IdentityBinding | null> {
    return this.getByAtprotoDid(did);
  }

  async getByAtprotoHandle(handle: string): Promise<IdentityBinding | null> {
    const canonicalAccountId = await this.redis.get(this.handleIndexKey(handle));
    if (!canonicalAccountId) return null;
    return this.getByCanonicalAccountId(canonicalAccountId);
  }

  async getByHandle(handle: string): Promise<IdentityBinding | null> {
    return this.getByAtprotoHandle(handle);
  }

  async findByHandle(handle: string): Promise<IdentityBinding | null> {
    return this.getByAtprotoHandle(handle);
  }

  async getByActivityPubActorUri(actorUri: string): Promise<IdentityBinding | null> {
    const canonicalAccountId = await this.redis.get(`${IDX_ACTOR}${actorUri}`);
    if (!canonicalAccountId) return null;
    return this.getByCanonicalAccountId(canonicalAccountId);
  }

  async getByWebId(webId: string): Promise<IdentityBinding | null> {
    const canonicalAccountId = await this.redis.get(`${IDX_WEBID}${webId}`);
    if (!canonicalAccountId) return null;
    return this.getByCanonicalAccountId(canonicalAccountId);
  }

  async getByContextAndUsername(contextId: string, username: string): Promise<IdentityBinding | null> {
    for await (const batch of this._scanBatches()) {
      for (const binding of batch) {
        if (binding.contextId !== contextId) continue;
        const slug = binding.activityPubActorUri.split('/').filter(Boolean).pop();
        if (slug === username) return binding;
      }
    }
    return null;
  }

  async create(binding: IdentityBinding): Promise<void> {
    const key = `${PREFIX}${binding.canonicalAccountId}`;
    const exists = await this.redis.exists(key);
    if (exists) {
      throw new RepositoryError(
        RepositoryErrorCode.DUPLICATE,
        `Identity binding already exists: ${binding.canonicalAccountId}`,
      );
    }
    await this._write(binding);
  }

  async update(binding: IdentityBinding): Promise<void> {
    const key = `${PREFIX}${binding.canonicalAccountId}`;
    const existing = await this.redis.get(key);
    if (!existing) {
      throw new RepositoryError(
        RepositoryErrorCode.NOT_FOUND,
        `Identity binding not found: ${binding.canonicalAccountId}`,
      );
    }
    const old = JSON.parse(existing) as IdentityBinding;
    await this._removeIndexes(old);
    await this._write(binding);
  }

  async upsert(binding: IdentityBinding): Promise<void> {
    const existing = await this.getByCanonicalAccountId(binding.canonicalAccountId);
    const atprotoSource = binding.atprotoSource ?? existing?.atprotoSource ?? 'local';
    const atprotoManaged =
      typeof binding.atprotoManaged === 'boolean'
        ? binding.atprotoManaged
        : existing?.atprotoManaged ?? atprotoSource !== 'external';

    const normalized: IdentityBinding = {
      ...binding,
      atprotoSource,
      atprotoManaged,
      atprotoPdsEndpoint:
        binding.atprotoPdsEndpoint ?? existing?.atprotoPdsEndpoint ?? null,
      createdAt: binding.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const multi = this.redis.multi();

    if (existing) {
      if (existing.atprotoDid && existing.atprotoDid !== normalized.atprotoDid) {
        multi.del(this.didIndexKey(existing.atprotoDid));
      }
      if (existing.atprotoHandle && existing.atprotoHandle !== normalized.atprotoHandle) {
        multi.del(this.handleIndexKey(existing.atprotoHandle));
      }
      if (existing.activityPubActorUri && existing.activityPubActorUri !== normalized.activityPubActorUri) {
        multi.del(this.actorIndexKey(existing.activityPubActorUri));
      }
      if (existing.webId && existing.webId !== normalized.webId) {
        multi.del(this.webIdIndexKey(existing.webId));
      }
    }

    multi.set(this.bindingKey(normalized.canonicalAccountId), JSON.stringify(normalized));
    multi.sadd(ALL_SET, normalized.canonicalAccountId);

    if (normalized.atprotoDid) {
      multi.set(this.didIndexKey(normalized.atprotoDid), normalized.canonicalAccountId);
    }
    if (normalized.atprotoHandle) {
      multi.set(this.handleIndexKey(normalized.atprotoHandle), normalized.canonicalAccountId);
    }
    if (normalized.activityPubActorUri) {
      multi.set(this.actorIndexKey(normalized.activityPubActorUri), normalized.canonicalAccountId);
    }
    if (normalized.webId) {
      multi.set(this.webIdIndexKey(normalized.webId), normalized.canonicalAccountId);
    }

    await this._execMultiOrThrow(multi, 'Identity binding upsert');
  }

  async delete(canonicalAccountId: string): Promise<boolean> {
    const key = `${PREFIX}${canonicalAccountId}`;
    const raw = await this.redis.get(key);
    if (!raw) return false;
    const binding = JSON.parse(raw) as IdentityBinding;
    await this._removeIndexes(binding);
    await this.redis.del(key);
    await this.redis.srem(ALL_SET, canonicalAccountId);
    return true;
  }

  async listByContext(contextId: string, limit = 100, offset = 0): Promise<IdentityBinding[]> {
    return this._collectMatches(binding => binding.contextId === contextId, limit, offset);
  }

  async listByStatus(
    status: 'active' | 'suspended' | 'deactivated',
    limit = 100,
    offset = 0,
  ): Promise<IdentityBinding[]> {
    return this._collectMatches(binding => binding.status === status, limit, offset);
  }

  async listWithPendingPlcUpdates(limit = 100, offset = 0): Promise<IdentityBinding[]> {
    return this._collectMatches(
      binding =>
        binding.plc?.plcUpdateState === 'PENDING_SUBMISSION' ||
        binding.plc?.plcUpdateState === 'SUBMITTED',
      limit,
      offset,
    );
  }

  async countByContext(contextId: string): Promise<number> {
    let count = 0;
    for await (const batch of this._scanBatches()) {
      for (const binding of batch) {
        if (binding.contextId === contextId) count += 1;
      }
    }
    return count;
  }

  async exists(canonicalAccountId: string): Promise<boolean> {
    return (await this.redis.exists(`${PREFIX}${canonicalAccountId}`)) > 0;
  }

  async didExists(did: string): Promise<boolean> {
    return (await this.redis.exists(`${IDX_DID}${did}`)) > 0;
  }

  async handleExists(handle: string): Promise<boolean> {
    return (await this.redis.exists(`${IDX_HANDLE}${handle.toLowerCase()}`)) > 0;
  }

  async actorUriExists(actorUri: string): Promise<boolean> {
    return (await this.redis.exists(`${IDX_ACTOR}${actorUri}`)) > 0;
  }

  async getBatch(canonicalAccountIds: string[]): Promise<Map<string, IdentityBinding>> {
    const result = new Map<string, IdentityBinding>();

    for (let start = 0; start < canonicalAccountIds.length; start += MGET_BATCH) {
      const ids = canonicalAccountIds.slice(start, start + MGET_BATCH);
      if (ids.length === 0) continue;
      const raws: Array<string | null> = await this.redis.mget(
        ...ids.map(id => this.bindingKey(id)),
      );

      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        const raw = raws[index];
        if (!id || !raw) continue;
        result.set(id, JSON.parse(raw) as IdentityBinding);
      }
    }

    return result;
  }

  async transaction<T>(callback: (repo: IdentityBindingRepository) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async health(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async _write(binding: IdentityBinding): Promise<void> {
    const multi = this.redis.multi();
    multi.set(this.bindingKey(binding.canonicalAccountId), JSON.stringify(binding));
    multi.sadd(ALL_SET, binding.canonicalAccountId);

    if (binding.atprotoDid) {
      multi.set(this.didIndexKey(binding.atprotoDid), binding.canonicalAccountId);
    }
    if (binding.atprotoHandle) {
      multi.set(this.handleIndexKey(binding.atprotoHandle), binding.canonicalAccountId);
    }
    if (binding.activityPubActorUri) {
      multi.set(this.actorIndexKey(binding.activityPubActorUri), binding.canonicalAccountId);
    }
    if (binding.webId) {
      multi.set(this.webIdIndexKey(binding.webId), binding.canonicalAccountId);
    }

    await this._execMultiOrThrow(multi, 'Identity binding write');
  }

  private async _removeIndexes(binding: IdentityBinding): Promise<void> {
    const multi = this.redis.multi();
    if (binding.atprotoDid) {
      multi.del(this.didIndexKey(binding.atprotoDid));
    }
    if (binding.atprotoHandle) {
      multi.del(this.handleIndexKey(binding.atprotoHandle));
    }
    if (binding.activityPubActorUri) {
      multi.del(this.actorIndexKey(binding.activityPubActorUri));
    }
    if (binding.webId) {
      multi.del(this.webIdIndexKey(binding.webId));
    }
    await this._execMultiOrThrow(multi, 'Identity index cleanup');
  }

  private async _execMultiOrThrow(multi: any, operation: string): Promise<void> {
    let results: unknown;
    try {
      results = await multi.exec();
    } catch (error) {
      throw this._redisRepositoryError(
        RepositoryErrorCode.PERSISTENCE_ERROR,
        `${operation} failed`,
        error,
      );
    }

    if (!Array.isArray(results)) {
      throw new RepositoryError(
        RepositoryErrorCode.PERSISTENCE_ERROR,
        `${operation} returned no Redis results`,
      );
    }

    for (const entry of results) {
      if (!Array.isArray(entry)) continue;
      const commandError = entry[0];
      if (!commandError) continue;
      throw this._redisRepositoryError(
        RepositoryErrorCode.PERSISTENCE_ERROR,
        `${operation} failed`,
        commandError,
      );
    }
  }

  private async _collectMatches(
    predicate: (binding: IdentityBinding) => boolean,
    limit: number,
    offset: number,
  ): Promise<IdentityBinding[]> {
    const safeLimit = Math.max(0, Math.trunc(limit));
    const safeOffset = Math.max(0, Math.trunc(offset));
    if (safeLimit === 0) return [];

    const results: IdentityBinding[] = [];
    let matched = 0;

    for await (const batch of this._scanBatches()) {
      for (const binding of batch) {
        if (!predicate(binding)) continue;
        if (matched < safeOffset) {
          matched += 1;
          continue;
        }
        results.push(binding);
        matched += 1;
        if (results.length >= safeLimit) return results;
      }
    }

    return results;
  }

  private async *_scanBatches(): AsyncGenerator<IdentityBinding[]> {
    let cursor = '0';
    const scanSessionKey = `${SCAN_SESSION_PREFIX}${randomUUID()}`;
    let scanSessionOpened = false;

    try {
      await this._openScanSession(scanSessionKey);
      scanSessionOpened = true;

      do {
        const response = await this.redis.sscan(ALL_SET, cursor, 'COUNT', SCAN_COUNT);
        const nextCursor = String(response?.[0] ?? '0');
        const scannedIds: string[] = Array.isArray(response?.[1])
          ? response[1].filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
          : [];

        // COUNT is only a work hint. Bound both de-duplication commands and MGET
        // payloads even if Redis returns a much larger scan page.
        for (let start = 0; start < scannedIds.length; start += MGET_BATCH) {
          const scanChunk = scannedIds.slice(start, start + MGET_BATCH);
          const ids = await this._dedupeScanIds(scanSessionKey, scanChunk);
          if (ids.length === 0) continue;

          const raws: Array<string | null> = await this.redis.mget(
            ...ids.map(id => this.bindingKey(id)),
          );
          const batch: IdentityBinding[] = [];

          for (const raw of raws) {
            if (!raw) continue;
            batch.push(JSON.parse(raw) as IdentityBinding);
          }

          if (batch.length > 0) yield batch;
        }

        cursor = nextCursor;
      } while (cursor !== '0');
    } finally {
      if (scanSessionOpened) {
        await this._cleanupScanSession(scanSessionKey);
      }
    }
  }

  private async _openScanSession(scanSessionKey: string): Promise<void> {
    try {
      const opened = await this.redis.eval(
        OPEN_SCAN_SESSION_LUA,
        1,
        scanSessionKey,
        SCAN_SESSION_SENTINEL,
        String(SCAN_SESSION_TTL_MS),
      );
      if (Number(opened) !== 1) {
        throw new Error('Redis did not initialize scan session');
      }
    } catch (error) {
      try {
        await this.redis.del(scanSessionKey);
      } catch {
        // Best effort only. The Lua creation is atomic, so any created session
        // already has a TTL and Redis will self-clean it after a crash.
      }
      throw this._redisRepositoryError(
        RepositoryErrorCode.QUERY_ERROR,
        'Identity scan session initialization failed',
        error,
      );
    }
  }

  private async _dedupeScanIds(scanSessionKey: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    if (ids.length > MGET_BATCH) {
      throw new RepositoryError(
        RepositoryErrorCode.QUERY_ERROR,
        'Identity scan de-duplication batch exceeded the configured bound',
      );
    }

    let result: unknown;
    try {
      result = await this.redis.eval(
        DEDUPE_SCAN_IDS_LUA,
        1,
        scanSessionKey,
        SCAN_SESSION_SENTINEL,
        String(SCAN_SESSION_TTL_MS),
        ...ids,
      );
    } catch (error) {
      throw this._redisRepositoryError(
        RepositoryErrorCode.QUERY_ERROR,
        'Identity scan de-duplication failed',
        error,
      );
    }

    if (!Array.isArray(result) || result.some(id => typeof id !== 'string')) {
      throw new RepositoryError(
        RepositoryErrorCode.QUERY_ERROR,
        'Identity scan de-duplication returned an invalid Redis response',
      );
    }

    return result as string[];
  }

  private async _cleanupScanSession(scanSessionKey: string): Promise<void> {
    try {
      await this.redis.del(scanSessionKey);
    } catch {
      // Best effort: the refreshed TTL is the crash/error self-healing path.
    }
  }

  private _redisRepositoryError(
    code: RepositoryErrorCode,
    message: string,
    error: unknown,
  ): RepositoryError {
    const redisError = error instanceof Error ? error.message : String(error);
    return new RepositoryError(code, `${message}: ${redisError}`, { redisError });
  }

  private bindingKey(canonicalAccountId: string): string {
    return `${PREFIX}${canonicalAccountId}`;
  }

  private didIndexKey(did: string): string {
    return `${IDX_DID}${did}`;
  }

  private handleIndexKey(handle: string): string {
    return `${IDX_HANDLE}${handle.toLowerCase()}`;
  }

  private actorIndexKey(actorUri: string): string {
    return `${IDX_ACTOR}${actorUri}`;
  }

  private webIdIndexKey(webId: string): string {
    return `${IDX_WEBID}${webId}`;
  }
}
