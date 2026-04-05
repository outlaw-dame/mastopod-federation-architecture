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

export class RedisIdentityBindingRepository implements IdentityBindingRepository {
  constructor(private readonly redis: any) {}

  // ---------------------------------------------------------------------------
  // Primary lookups
  // ---------------------------------------------------------------------------

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
    // Scan all bindings in the context looking for a matching username derived
    // from the activityPubActorUri (last path segment).
    const all = await this._scanAll();
    for (const b of all) {
      if (b.contextId !== contextId) continue;
      const slug = b.activityPubActorUri.split('/').filter(Boolean).pop();
      if (slug === username) return b;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

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
    // Clean up stale secondary indexes before writing new ones
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

    await multi.exec();
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

  // ---------------------------------------------------------------------------
  // List / count
  // ---------------------------------------------------------------------------

  async listByContext(contextId: string, limit = 100, offset = 0): Promise<IdentityBinding[]> {
    const all = await this._scanAll();
    return all.filter(b => b.contextId === contextId).slice(offset, offset + limit);
  }

  async listByStatus(
    status: 'active' | 'suspended' | 'deactivated',
    limit = 100,
    offset = 0,
  ): Promise<IdentityBinding[]> {
    const all = await this._scanAll();
    return all.filter(b => b.status === status).slice(offset, offset + limit);
  }

  async listWithPendingPlcUpdates(limit = 100, offset = 0): Promise<IdentityBinding[]> {
    const all = await this._scanAll();
    return all
      .filter(b => b.plc?.plcUpdateState === 'PENDING_SUBMISSION' || b.plc?.plcUpdateState === 'SUBMITTED')
      .slice(offset, offset + limit);
  }

  async countByContext(contextId: string): Promise<number> {
    const all = await this._scanAll();
    return all.filter(b => b.contextId === contextId).length;
  }

  // ---------------------------------------------------------------------------
  // Existence checks
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Batch
  // ---------------------------------------------------------------------------

  async getBatch(canonicalAccountIds: string[]): Promise<Map<string, IdentityBinding>> {
    const result = new Map<string, IdentityBinding>();
    await Promise.all(
      canonicalAccountIds.map(async id => {
        const b = await this.getByCanonicalAccountId(id);
        if (b) result.set(id, b);
      }),
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // Transaction (pass-through; true atomicity deferred)
  // ---------------------------------------------------------------------------

  async transaction<T>(callback: (repo: IdentityBindingRepository) => Promise<T>): Promise<T> {
    return callback(this);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async health(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _write(binding: IdentityBinding): Promise<void> {
    await this.redis.set(this.bindingKey(binding.canonicalAccountId), JSON.stringify(binding));
    await this.redis.sadd(ALL_SET, binding.canonicalAccountId);

    if (binding.atprotoDid) {
      await this.redis.set(this.didIndexKey(binding.atprotoDid), binding.canonicalAccountId);
    }
    if (binding.atprotoHandle) {
      await this.redis.set(this.handleIndexKey(binding.atprotoHandle), binding.canonicalAccountId);
    }
    if (binding.activityPubActorUri) {
      await this.redis.set(this.actorIndexKey(binding.activityPubActorUri), binding.canonicalAccountId);
    }
    if (binding.webId) {
      await this.redis.set(this.webIdIndexKey(binding.webId), binding.canonicalAccountId);
    }
  }

  private async _removeIndexes(binding: IdentityBinding): Promise<void> {
    if (binding.atprotoDid) {
      await this.redis.del(this.didIndexKey(binding.atprotoDid));
    }
    if (binding.atprotoHandle) {
      await this.redis.del(this.handleIndexKey(binding.atprotoHandle));
    }
    if (binding.activityPubActorUri) {
      await this.redis.del(this.actorIndexKey(binding.activityPubActorUri));
    }
    if (binding.webId) {
      await this.redis.del(this.webIdIndexKey(binding.webId));
    }
  }

  private async _scanAll(): Promise<IdentityBinding[]> {
    const ids: string[] = await this.redis.smembers(ALL_SET);
    const results: IdentityBinding[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(this.bindingKey(id));
      if (raw) results.push(JSON.parse(raw) as IdentityBinding);
    }
    return results;
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
