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
 * Transactions are not yet atomic (Redis MULTI support deferred).
 * Single-process writes are safe; multi-replica writers need coordination.
 */

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
    const results = await multi.exec();
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
      const message = commandError instanceof Error ? commandError.message : String(commandError);
      throw new RepositoryError(
        RepositoryErrorCode.PERSISTENCE_ERROR,
        `${operation} failed: ${message}`,
        { redisError: message },
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
    const seenIds = new Set<string>();

    do {
      const response = await this.redis.sscan(ALL_SET, cursor, 'COUNT', SCAN_COUNT);
      const nextCursor = String(response?.[0] ?? '0');
      const scannedIds: string[] = Array.isArray(response?.[1]) ? response[1] : [];
      const ids = scannedIds.filter(id => {
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });

      if (ids.length > 0) {
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
