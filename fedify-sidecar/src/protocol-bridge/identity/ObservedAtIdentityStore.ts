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

export interface ObservedAtIdentityStore {
  observe(input: ObserveAtIdentityInput): Promise<ObservedAtIdentityRecord>;
  getByDid(did: string): Promise<ObservedAtIdentityRecord | null>;
  listAll(): Promise<ObservedAtIdentityRecord[]>;
  getSummary(): Promise<ObservedAtIdentitySummary>;
  listTopUnbound(limit: number): Promise<ObservedAtIdentityRecord[]>;
  listTopBound(limit: number): Promise<ObservedAtIdentityRecord[]>;
  listRecent(limit: number): Promise<ObservedAtIdentityRecord[]>;
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
};

export class RedisObservedAtIdentityStore implements ObservedAtIdentityStore {
  private readonly keyPrefix: string;

  public constructor(
    private readonly redis: RedisLike,
    keyPrefix = "protocol-bridge:observed-at-identities",
  ) {
    this.keyPrefix = keyPrefix;
  }

  public async observe(input: ObserveAtIdentityInput): Promise<ObservedAtIdentityRecord> {
    const existing = await this.getByDid(input.did);
    const next = mergeObservation(existing, input);
    await this.redis.set(this.buildDidKey(input.did), JSON.stringify(next));
    await this.redis.sadd(this.buildAllKey(), input.did);
    return next;
  }

  public async getByDid(did: string): Promise<ObservedAtIdentityRecord | null> {
    const raw = await this.redis.get(this.buildDidKey(did));
    if (!raw) {
      return null;
    }

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

  public async listAll(): Promise<ObservedAtIdentityRecord[]> {
    const dids = await this.redis.smembers(this.buildAllKey());
    const results = await Promise.all(dids.map(async (did) => this.getByDid(did)));
    return results.filter((record): record is ObservedAtIdentityRecord => !!record);
  }

  public async getSummary(): Promise<ObservedAtIdentitySummary> {
    const records = await this.listAll();
    return records.reduce<ObservedAtIdentitySummary>((summary, record) => {
      summary.totalObserved += 1;
      if (record.bound) {
        summary.boundObserved += 1;
      } else {
        summary.unboundObserved += 1;
      }
      summary.projectedCount += record.projectedCount;
      summary.skippedUnboundActorCount += record.skippedUnboundActorCount;
      summary.skippedOtherCount += record.skippedOtherCount;
      summary.failedCount += record.failedCount;
      return summary;
    }, {
      totalObserved: 0,
      boundObserved: 0,
      unboundObserved: 0,
      projectedCount: 0,
      skippedUnboundActorCount: 0,
      skippedOtherCount: 0,
      failedCount: 0,
    });
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

  private async listFiltered(
    limit: number,
    predicate: (record: ObservedAtIdentityRecord) => boolean,
    sorter: (left: ObservedAtIdentityRecord, right: ObservedAtIdentityRecord) => number,
  ): Promise<ObservedAtIdentityRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const records = await this.listAll();
    return records.filter(predicate).sort(sorter).slice(0, safeLimit);
  }

  private buildDidKey(did: string): string {
    return `${this.keyPrefix}:did:${did}`;
  }

  private buildAllKey(): string {
    return `${this.keyPrefix}:all`;
  }
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