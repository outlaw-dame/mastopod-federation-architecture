import { randomUUID } from "node:crypto";

export type AtIdentityObservationOutcome =
  | "projected"
  | "skipped_unbound_actor"
  | "skipped_policy_denied"
  | "skipped_unsupported"
  | "skipped_already_projected"
  | "skipped_loopback_mirrored"
  | "failed_projection_error";

export interface ObservedAtIdentityRecord {
  did: string;
  handle: string | null;
  pdsEndpoint: string | null;
  canonicalAccountId: string | null;
  activityPubActorUri: string | null;
  bound: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  totalSeen: number;
  projectedCount: number;
  skippedUnboundActorCount: number;
  skippedOtherCount: number;
  failedCount: number;
  lastOutcome: AtIdentityObservationOutcome;
}

export interface ObserveAtIdentityInput {
  did: string;
  handle?: string | null;
  pdsEndpoint?: string | null;
  canonicalAccountId?: string | null;
  activityPubActorUri?: string | null;
  bound: boolean;
  observedAt: string;
  outcome: AtIdentityObservationOutcome;
}

export interface ObservedAtIdentitySummary {
  totalObserved: number;
  boundObserved: number;
  unboundObserved: number;
  projectedCount: number;
  skippedUnboundActorCount: number;
  skippedOtherCount: number;
  failedCount: number;
}

export interface ObservedAtIdentityDashboard {
  summary: ObservedAtIdentitySummary;
  topUnbound: ObservedAtIdentityRecord[];
  topBound: ObservedAtIdentityRecord[];
  recent: ObservedAtIdentityRecord[];
}

export interface ObservedAtIdentityStore {
  observe(input: ObserveAtIdentityInput): Promise<ObservedAtIdentityRecord>;
  getByDid(did: string): Promise<ObservedAtIdentityRecord | null>;
  listAll(): Promise<ObservedAtIdentityRecord[]>;
  getSummary(): Promise<ObservedAtIdentitySummary>;
  listTopUnbound(limit: number): Promise<ObservedAtIdentityRecord[]>;
  listTopBound(limit: number): Promise<ObservedAtIdentityRecord[]>;
  listRecent(limit: number): Promise<ObservedAtIdentityRecord[]>;
  getDashboard?(limit: number): Promise<ObservedAtIdentityDashboard>;
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  del?(...keys: string[]): Promise<unknown>;
  eval?(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  sscan?(
    key: string,
    cursor: string,
    countToken: "COUNT",
    count: number,
  ): Promise<[string, string[]]>;
  mget?(...keys: string[]): Promise<Array<string | null>>;
};

const DASHBOARD_SCAN_COUNT = 128;
const DASHBOARD_MGET_BATCH = 128;
const DASHBOARD_SCAN_SESSION_TTL_MS = 5 * 60_000;

const OPEN_DASHBOARD_SCAN_SESSION_LUA = `
local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return redis.error_reply('OBSERVED_AT_SCAN_SESSION_INVALID_TTL')
end
redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('PEXPIRE', KEYS[1], ttl) ~= 1 then
  return redis.error_reply('OBSERVED_AT_SCAN_SESSION_TTL_FAILED')
end
return 1
`;

const DEDUPE_DASHBOARD_SCAN_IDS_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) ~= 1 then
  return redis.error_reply('OBSERVED_AT_SCAN_SESSION_EXPIRED')
end
local ttl = tonumber(ARGV[2])
if not ttl or ttl <= 0 then
  return redis.error_reply('OBSERVED_AT_SCAN_SESSION_INVALID_TTL')
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

/**
 * Atomically merges one observation into the existing JSON record and indexes
 * the DID. Keeping the record as JSON preserves the current storage schema and
 * all dashboard readers while removing the GET/merge/SET lost-update window.
 *
 * ARGV[1] is a JSON-encoded ObserveAtIdentityInput. Undefined optional fields
 * are omitted by JSON.stringify, so the script can distinguish "not supplied"
 * from an explicit JSON null in the same way the TypeScript merge uses `??`.
 */
const OBSERVE_AT_IDENTITY_LUA = `
local raw = redis.call('GET', KEYS[1])
local input = cjson.decode(ARGV[1])
local record = nil

if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' and type(decoded.did) == 'string' then
    record = decoded
  end
end

local function count(value)
  local parsed = tonumber(value)
  if not parsed or parsed < 0 then return 0 end
  return math.floor(parsed)
end

local function supplied(value)
  return value ~= nil and value ~= cjson.null
end

if not record then
  record = {
    did = input.did,
    handle = cjson.null,
    pdsEndpoint = cjson.null,
    canonicalAccountId = cjson.null,
    activityPubActorUri = cjson.null,
    bound = false,
    firstSeenAt = input.observedAt,
    lastSeenAt = input.observedAt,
    totalSeen = 0,
    projectedCount = 0,
    skippedUnboundActorCount = 0,
    skippedOtherCount = 0,
    failedCount = 0,
    lastOutcome = input.outcome
  }
end

record.did = input.did
if supplied(input.handle) then record.handle = input.handle end
if supplied(input.pdsEndpoint) then record.pdsEndpoint = input.pdsEndpoint end
if supplied(input.canonicalAccountId) then record.canonicalAccountId = input.canonicalAccountId end
if supplied(input.activityPubActorUri) then record.activityPubActorUri = input.activityPubActorUri end
record.bound = record.bound == true or input.bound == true
if type(record.firstSeenAt) ~= 'string' then record.firstSeenAt = input.observedAt end
record.lastSeenAt = input.observedAt

record.totalSeen = count(record.totalSeen) + 1
record.projectedCount = count(record.projectedCount)
record.skippedUnboundActorCount = count(record.skippedUnboundActorCount)
record.skippedOtherCount = count(record.skippedOtherCount)
record.failedCount = count(record.failedCount)

if input.outcome == 'projected' then
  record.projectedCount = record.projectedCount + 1
elseif input.outcome == 'skipped_unbound_actor' then
  record.skippedUnboundActorCount = record.skippedUnboundActorCount + 1
elseif input.outcome == 'failed_projection_error' then
  record.failedCount = record.failedCount + 1
else
  record.skippedOtherCount = record.skippedOtherCount + 1
end
record.lastOutcome = input.outcome

local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded)
redis.call('SADD', KEYS[2], input.did)
return encoded
`;

export class RedisObservedAtIdentityStore implements ObservedAtIdentityStore {
  private readonly keyPrefix: string;

  public constructor(
    private readonly redis: RedisLike,
    keyPrefix = "protocol-bridge:observed-at-identities",
  ) {
    this.keyPrefix = keyPrefix;
  }

  public async observe(input: ObserveAtIdentityInput): Promise<ObservedAtIdentityRecord> {
    if (!this.redis.eval) {
      // Compatibility fallback for lightweight/custom Redis-like adapters. The
      // production ioredis client exposes EVAL and therefore always takes the
      // atomic path. Keeping this fallback avoids turning the optimization into
      // an interface break for existing test/dry-run stores.
      const existing = await this.getByDid(input.did);
      const next = mergeObservation(existing, input);
      await this.redis.set(this.buildDidKey(input.did), JSON.stringify(next));
      await this.redis.sadd(this.buildAllKey(), input.did);
      return next;
    }

    const encoded = await this.redis.eval(
      OBSERVE_AT_IDENTITY_LUA,
      2,
      this.buildDidKey(input.did),
      this.buildAllKey(),
      JSON.stringify(input),
    );
    if (typeof encoded !== "string") {
      throw new Error("Observed AT identity atomic update returned an invalid payload");
    }

    const record = parseObservedIdentityRecord(encoded);
    if (!record || record.did !== input.did) {
      throw new Error("Observed AT identity atomic update returned an invalid record");
    }
    return record;
  }

  public async getByDid(did: string): Promise<ObservedAtIdentityRecord | null> {
    return parseObservedIdentityRecord(await this.redis.get(this.buildDidKey(did)));
  }

  /** Explicit complete-population API. Derived views intentionally do not call this. */
  public async listAll(): Promise<ObservedAtIdentityRecord[]> {
    const dids = await this.redis.smembers(this.buildAllKey());
    const results = await Promise.all(dids.map(async (did) => this.getByDid(did)));
    return results.filter((record): record is ObservedAtIdentityRecord => !!record);
  }

  public async getSummary(): Promise<ObservedAtIdentitySummary> {
    const summary = emptySummary();
    for await (const batch of this.scanRecordBatches()) {
      for (const record of batch) addRecordToSummary(summary, record);
    }
    return summary;
  }

  public async listTopUnbound(limit: number): Promise<ObservedAtIdentityRecord[]> {
    return this.listFiltered(limit, (record) => !record.bound, bySeenCountDesc);
  }

  public async listTopBound(limit: number): Promise<ObservedAtIdentityRecord[]> {
    return this.listFiltered(limit, (record) => record.bound, bySeenCountDesc);
  }

  public async listRecent(limit: number): Promise<ObservedAtIdentityRecord[]> {
    return this.listFiltered(limit, () => true, byLastSeenDesc);
  }

  public async getDashboard(limit: number): Promise<ObservedAtIdentityDashboard> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const summary = emptySummary();
    let topUnbound: ObservedAtIdentityRecord[] = [];
    let topBound: ObservedAtIdentityRecord[] = [];
    let recent: ObservedAtIdentityRecord[] = [];

    for await (const batch of this.scanRecordBatches()) {
      for (const record of batch) {
        addRecordToSummary(summary, record);
        if (record.bound) {
          topBound = retainTop(topBound, record, safeLimit, bySeenCountDesc);
        } else {
          topUnbound = retainTop(topUnbound, record, safeLimit, bySeenCountDesc);
        }
        recent = retainTop(recent, record, safeLimit, byLastSeenDesc);
      }
    }

    return { summary, topUnbound, topBound, recent };
  }

  private async listFiltered(
    limit: number,
    predicate: (record: ObservedAtIdentityRecord) => boolean,
    sorter: (left: ObservedAtIdentityRecord, right: ObservedAtIdentityRecord) => number,
  ): Promise<ObservedAtIdentityRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    let results: ObservedAtIdentityRecord[] = [];
    for await (const batch of this.scanRecordBatches()) {
      for (const record of batch) {
        if (predicate(record)) results = retainTop(results, record, safeLimit, sorter);
      }
    }
    return results;
  }

  private async *scanRecordBatches(): AsyncGenerator<ObservedAtIdentityRecord[]> {
    if (!this.redis.sscan || !this.redis.mget) {
      const records = await this.listAll();
      if (records.length > 0) yield records;
      return;
    }

    if (this.redis.eval && this.redis.del) {
      for await (const records of this.scanRecordBatchesWithRedisSession()) {
        yield records;
      }
      return;
    }

    for await (const records of this.scanRecordBatchesWithMemoryFallback()) {
      yield records;
    }
  }

  private async *scanRecordBatchesWithRedisSession(): AsyncGenerator<ObservedAtIdentityRecord[]> {
    const redis = this.redis as RedisLike & Required<Pick<RedisLike, "eval" | "del" | "sscan" | "mget">>;
    let cursor = "0";
    const sessionKey = `${this.keyPrefix}:scan-seen:${randomUUID()}`;
    const sentinel = `\u0000observed-at-scan:${randomUUID()}`;
    let opened = false;

    try {
      const openResult = await redis.eval(
        OPEN_DASHBOARD_SCAN_SESSION_LUA,
        1,
        sessionKey,
        sentinel,
        String(DASHBOARD_SCAN_SESSION_TTL_MS),
      );
      if (Number(openResult) !== 1) {
        throw new Error("Redis did not initialize observed identity scan session");
      }
      opened = true;

      do {
        const response = await redis.sscan(
          this.buildAllKey(),
          cursor,
          "COUNT",
          DASHBOARD_SCAN_COUNT,
        );
        const nextCursor = String(response?.[0] ?? "0");
        const scanned = Array.isArray(response?.[1])
          ? response[1].filter((did): did is string => typeof did === "string" && did.length > 0)
          : [];

        for (let start = 0; start < scanned.length; start += DASHBOARD_MGET_BATCH) {
          const chunk = scanned.slice(start, start + DASHBOARD_MGET_BATCH);
          const fresh = await this.dedupeScanDids(redis, sessionKey, sentinel, chunk);
          if (fresh.length === 0) continue;
          const records = await this.loadRecordBatch(redis, fresh);
          if (records.length > 0) yield records;
        }

        cursor = nextCursor;
      } while (cursor !== "0");
    } finally {
      if (opened) {
        await redis.del(sessionKey).catch(() => undefined);
      }
    }
  }

  private async *scanRecordBatchesWithMemoryFallback(): AsyncGenerator<ObservedAtIdentityRecord[]> {
    const redis = this.redis as RedisLike & Required<Pick<RedisLike, "sscan" | "mget">>;
    let cursor = "0";
    const seenDids = new Set<string>();

    do {
      const response = await redis.sscan(
        this.buildAllKey(),
        cursor,
        "COUNT",
        DASHBOARD_SCAN_COUNT,
      );
      const nextCursor = String(response?.[0] ?? "0");
      const scanned = Array.isArray(response?.[1])
        ? response[1].filter((did): did is string => typeof did === "string" && did.length > 0)
        : [];

      for (let start = 0; start < scanned.length; start += DASHBOARD_MGET_BATCH) {
        const chunk = scanned.slice(start, start + DASHBOARD_MGET_BATCH);
        const fresh = chunk.filter((did) => {
          if (seenDids.has(did)) return false;
          seenDids.add(did);
          return true;
        });
        if (fresh.length === 0) continue;
        const records = await this.loadRecordBatch(redis, fresh);
        if (records.length > 0) yield records;
      }

      cursor = nextCursor;
    } while (cursor !== "0");
  }

  private async dedupeScanDids(
    redis: RedisLike & Required<Pick<RedisLike, "eval">>,
    sessionKey: string,
    sentinel: string,
    dids: string[],
  ): Promise<string[]> {
    if (dids.length === 0) return [];
    const result = await redis.eval(
      DEDUPE_DASHBOARD_SCAN_IDS_LUA,
      1,
      sessionKey,
      sentinel,
      String(DASHBOARD_SCAN_SESSION_TTL_MS),
      ...dids,
    );
    if (!Array.isArray(result) || result.some((value) => typeof value !== "string")) {
      throw new Error("Observed identity scan de-duplication returned an invalid payload");
    }
    return result as string[];
  }

  private async loadRecordBatch(
    redis: RedisLike & Required<Pick<RedisLike, "mget">>,
    dids: string[],
  ): Promise<ObservedAtIdentityRecord[]> {
    if (dids.length > DASHBOARD_MGET_BATCH) {
      throw new Error("Observed identity MGET batch exceeded configured bound");
    }
    const raws = await redis.mget(...dids.map((did) => this.buildDidKey(did)));
    return raws
      .map((raw) => parseObservedIdentityRecord(raw))
      .filter((record): record is ObservedAtIdentityRecord => !!record);
  }

  private buildDidKey(did: string): string {
    return `${this.keyPrefix}:did:${did}`;
  }

  private buildAllKey(): string {
    return `${this.keyPrefix}:all`;
  }
}

function parseObservedIdentityRecord(raw: string | null): ObservedAtIdentityRecord | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ObservedAtIdentityRecord>;
    if (typeof parsed.did !== "string") {
      return null;
    }
    return {
      did: parsed.did,
      handle: typeof parsed.handle === "string" ? parsed.handle : null,
      pdsEndpoint: typeof parsed.pdsEndpoint === "string" ? parsed.pdsEndpoint : null,
      canonicalAccountId: typeof parsed.canonicalAccountId === "string" ? parsed.canonicalAccountId : null,
      activityPubActorUri: typeof parsed.activityPubActorUri === "string" ? parsed.activityPubActorUri : null,
      bound: parsed.bound === true,
      firstSeenAt: typeof parsed.firstSeenAt === "string" ? parsed.firstSeenAt : new Date(0).toISOString(),
      lastSeenAt: typeof parsed.lastSeenAt === "string" ? parsed.lastSeenAt : new Date(0).toISOString(),
      totalSeen: toCount(parsed.totalSeen),
      projectedCount: toCount(parsed.projectedCount),
      skippedUnboundActorCount: toCount(parsed.skippedUnboundActorCount),
      skippedOtherCount: toCount(parsed.skippedOtherCount),
      failedCount: toCount(parsed.failedCount),
      lastOutcome: isOutcome(parsed.lastOutcome) ? parsed.lastOutcome : "skipped_unsupported",
    };
  } catch {
    return null;
  }
}

function emptySummary(): ObservedAtIdentitySummary {
  return {
    totalObserved: 0,
    boundObserved: 0,
    unboundObserved: 0,
    projectedCount: 0,
    skippedUnboundActorCount: 0,
    skippedOtherCount: 0,
    failedCount: 0,
  };
}

function addRecordToSummary(summary: ObservedAtIdentitySummary, record: ObservedAtIdentityRecord): void {
  summary.totalObserved += 1;
  if (record.bound) summary.boundObserved += 1;
  else summary.unboundObserved += 1;
  summary.projectedCount += record.projectedCount;
  summary.skippedUnboundActorCount += record.skippedUnboundActorCount;
  summary.skippedOtherCount += record.skippedOtherCount;
  summary.failedCount += record.failedCount;
}

function summarizeObservedIdentities(records: ObservedAtIdentityRecord[]): ObservedAtIdentitySummary {
  const summary = emptySummary();
  for (const record of records) addRecordToSummary(summary, record);
  return summary;
}

function retainTop(
  records: ObservedAtIdentityRecord[],
  candidate: ObservedAtIdentityRecord,
  limit: number,
  sorter: (left: ObservedAtIdentityRecord, right: ObservedAtIdentityRecord) => number,
): ObservedAtIdentityRecord[] {
  const next = [...records, candidate].sort(sorter);
  if (next.length > limit) next.length = limit;
  return next;
}

function mergeObservation(
  existing: ObservedAtIdentityRecord | null,
  input: ObserveAtIdentityInput,
): ObservedAtIdentityRecord {
  const base: ObservedAtIdentityRecord = existing ?? {
    did: input.did,
    handle: null,
    pdsEndpoint: null,
    canonicalAccountId: null,
    activityPubActorUri: null,
    bound: false,
    firstSeenAt: input.observedAt,
    lastSeenAt: input.observedAt,
    totalSeen: 0,
    projectedCount: 0,
    skippedUnboundActorCount: 0,
    skippedOtherCount: 0,
    failedCount: 0,
    lastOutcome: input.outcome,
  };

  const next: ObservedAtIdentityRecord = {
    ...base,
    did: input.did,
    handle: input.handle ?? base.handle,
    pdsEndpoint: input.pdsEndpoint ?? base.pdsEndpoint,
    canonicalAccountId: input.canonicalAccountId ?? base.canonicalAccountId,
    activityPubActorUri: input.activityPubActorUri ?? base.activityPubActorUri,
    bound: input.bound || base.bound,
    firstSeenAt: base.firstSeenAt,
    lastSeenAt: input.observedAt,
    totalSeen: base.totalSeen + 1,
    projectedCount: base.projectedCount,
    skippedUnboundActorCount: base.skippedUnboundActorCount,
    skippedOtherCount: base.skippedOtherCount,
    failedCount: base.failedCount,
    lastOutcome: input.outcome,
  };

  switch (input.outcome) {
    case "projected":
      next.projectedCount += 1;
      break;
    case "skipped_unbound_actor":
      next.skippedUnboundActorCount += 1;
      break;
    case "failed_projection_error":
      next.failedCount += 1;
      break;
    default:
      next.skippedOtherCount += 1;
      break;
  }

  return next;
}

function isOutcome(value: unknown): value is AtIdentityObservationOutcome {
  return typeof value === "string" && new Set<AtIdentityObservationOutcome>([
    "projected",
    "skipped_unbound_actor",
    "skipped_policy_denied",
    "skipped_unsupported",
    "skipped_already_projected",
    "skipped_loopback_mirrored",
    "failed_projection_error",
  ]).has(value as AtIdentityObservationOutcome);
}

function toCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function bySeenCountDesc(left: ObservedAtIdentityRecord, right: ObservedAtIdentityRecord): number {
  return right.totalSeen - left.totalSeen || right.lastSeenAt.localeCompare(left.lastSeenAt);
}

function byLastSeenDesc(left: ObservedAtIdentityRecord, right: ObservedAtIdentityRecord): number {
  return right.lastSeenAt.localeCompare(left.lastSeenAt) || right.totalSeen - left.totalSeen;
}
