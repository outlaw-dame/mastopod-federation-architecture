import type { ProjectionLedgerPort, ProjectionLedgerRecord } from "../ports/ProtocolBridgePorts.js";
import type { ProtocolName } from "../canonical/CanonicalEnvelope.js";

const DEFAULT_LEDGER_TTL_SECONDS = 60 * 60 * 24 * 14;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

export class InMemoryProjectionLedger implements ProjectionLedgerPort {
  private readonly records = new Map<string, ProjectionLedgerRecord>();

  public async get(canonicalIntentId: string): Promise<ProjectionLedgerRecord | null> {
    return this.records.get(canonicalIntentId) ?? null;
  }

  public async markProjected(
    canonicalIntentId: string,
    sourceProtocol: ProtocolName,
    targetProtocol: ProtocolName,
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.records.get(canonicalIntentId);
    const next: ProjectionLedgerRecord = {
      canonicalIntentId,
      sourceProtocol: existing?.sourceProtocol ?? sourceProtocol,
      projectedToActivityPub:
        targetProtocol === "activitypub" ? true : (existing?.projectedToActivityPub ?? false),
      projectedToAtproto:
        targetProtocol === "atproto" ? true : (existing?.projectedToAtproto ?? false),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastProjectedAt: now,
    };
    this.records.set(canonicalIntentId, next);
  }
}

export interface RedisProjectionLedgerOptions {
  keyPrefix?: string;
  ttlSeconds?: number;
}

export class RedisProjectionLedger implements ProjectionLedgerPort {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  public constructor(
    private readonly redis: RedisLike,
    options: RedisProjectionLedgerOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "protocol-bridge:ledger";
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_LEDGER_TTL_SECONDS;
  }

  public async get(canonicalIntentId: string): Promise<ProjectionLedgerRecord | null> {
    const raw = await this.redis.get(this.buildKey(canonicalIntentId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as ProjectionLedgerRecord;
    } catch {
      return null;
    }
  }

  public async markProjected(
    canonicalIntentId: string,
    sourceProtocol: ProtocolName,
    targetProtocol: ProtocolName,
  ): Promise<void> {
    const existing = await this.get(canonicalIntentId);
    const now = new Date().toISOString();
    const record: ProjectionLedgerRecord = {
      canonicalIntentId,
      sourceProtocol: existing?.sourceProtocol ?? sourceProtocol,
      projectedToActivityPub:
        targetProtocol === "activitypub" ? true : (existing?.projectedToActivityPub ?? false),
      projectedToAtproto:
        targetProtocol === "atproto" ? true : (existing?.projectedToAtproto ?? false),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastProjectedAt: now,
    };

    await this.redis.set(
      this.buildKey(canonicalIntentId),
      JSON.stringify(record),
      "EX",
      this.ttlSeconds,
    );
  }

  private buildKey(canonicalIntentId: string): string {
    return `${this.keyPrefix}:${canonicalIntentId}`;
  }
}
