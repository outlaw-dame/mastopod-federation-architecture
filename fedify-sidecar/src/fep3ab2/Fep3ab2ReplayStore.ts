import type { Redis } from "ioredis";
import { z } from "zod";
import { metrics } from "../metrics/index.js";
import { logger } from "../utils/logger.js";
import {
  FepPublishedTopicSchema,
  FepSseEventNameSchema,
  type FepDispatchEvent,
  type FepPublishedTopic,
  type FepSseEventName,
  type FepSubscriptionTopic,
} from "./contracts.js";
import { isReplayableTopic, topicMatches } from "./topics.js";

const REPLAY_EVENT_ID_PREFIX = "fep3ab2-replay-";

const PersistedReplayEventSchema = z.object({
  sequence: z.number().int().positive(),
  wireId: z.string().trim().min(1).max(128),
  topic: FepPublishedTopicSchema,
  event: FepSseEventNameSchema,
  data: z.record(z.string(), z.unknown()),
});

export type FepStoredReplayEvent = z.infer<typeof PersistedReplayEventSchema>;

export interface Fep3ab2ReplayStoreOptions {
  prefix?: string;
  ttlSec?: number;
  maxIndexSize?: number;
  maxReplayEvents?: number;
  maxPayloadBytes?: number;
  scanBatchSize?: number;
  maxScanEvents?: number;
}

export class Fep3ab2ReplayStore {
  private readonly prefix: string;
  private readonly ttlSec: number;
  private readonly maxIndexSize: number;
  private readonly maxReplayEventsValue: number;
  private readonly maxPayloadBytes: number;
  private readonly scanBatchSize: number;
  private readonly maxScanEvents: number;

  public constructor(
    private readonly redis: Redis,
    options: Fep3ab2ReplayStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? "fep3ab2";
    this.ttlSec = Math.max(60, Math.min(options.ttlSec ?? 900, 7_200));
    this.maxIndexSize = Math.max(128, Math.min(options.maxIndexSize ?? 10_000, 100_000));
    this.maxReplayEventsValue = Math.max(1, Math.min(options.maxReplayEvents ?? 500, 5_000));
    this.maxPayloadBytes = Math.max(1_024, Math.min(options.maxPayloadBytes ?? 262_144, 1_048_576));
    this.scanBatchSize = Math.max(16, Math.min(options.scanBatchSize ?? 128, 1_024));
    this.maxScanEvents = Math.max(
      this.maxReplayEventsValue,
      Math.min(options.maxScanEvents ?? this.maxReplayEventsValue * 10, this.maxIndexSize),
    );
  }

  public get maxReplayEvents(): number {
    return this.maxReplayEventsValue;
  }

  public shouldPersist(event: FepDispatchEvent): boolean {
    return !event.principal && isReplayableTopic(event.topic);
  }

  public async append(event: FepDispatchEvent): Promise<FepStoredReplayEvent | null> {
    if (!this.shouldPersist(event)) {
      return null;
    }

    const sequence = await this.redis.incr(this.sequenceKey());
    const record: FepStoredReplayEvent = {
      sequence,
      wireId: buildReplayEventId(sequence),
      topic: event.topic,
      event: event.event,
      data: event.data,
    };

    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, "utf8") > this.maxPayloadBytes) {
      logger.warn("FEP-3ab2 replay persistence skipped oversized event", {
        topic: event.topic,
        event: event.event,
        sequence,
      });
      metrics.fepStreamingReplayEventsTotal.inc({ action: "skipped_oversized" });
      return null;
    }

    await this.redis
      .multi()
      .set(this.eventKey(sequence), serialized, "EX", this.ttlSec)
      .zadd(this.indexKey(), sequence, String(sequence))
      .zremrangebyrank(this.indexKey(), 0, -(this.maxIndexSize + 1))
      .expire(this.indexKey(), this.ttlSec)
      .exec();

    metrics.fepStreamingReplayEventsTotal.inc({ action: "stored" });
    return record;
  }

  public async replayAfter(
    lastEventId: string | undefined,
    subscriptions: readonly FepSubscriptionTopic[],
  ): Promise<FepStoredReplayEvent[]> {
    const lastSequence = parseReplayEventId(lastEventId);
    if (lastSequence === null || subscriptions.length === 0) {
      return [];
    }

    const results: FepStoredReplayEvent[] = [];
    const staleMembers = new Set<string>();
    let offset = 0;
    let scanned = 0;

    while (results.length < this.maxReplayEventsValue && scanned < this.maxScanEvents) {
      const remainingScanBudget = Math.max(0, this.maxScanEvents - scanned);
      const batchSize = Math.min(this.scanBatchSize, remainingScanBudget);
      if (batchSize === 0) {
        break;
      }

      const members = await this.redis.zrangebyscore(
        this.indexKey(),
        `(${lastSequence}`,
        "+inf",
        "LIMIT",
        offset,
        batchSize,
      );

      if (members.length === 0) {
        break;
      }

      offset += members.length;
      scanned += members.length;

      for (const member of members) {
        const sequence = Number.parseInt(member, 10);
        if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) {
          staleMembers.add(member);
          continue;
        }

        const record = await this.readPersistedRecord(sequence);
        if (!record) {
          staleMembers.add(member);
          metrics.fepStreamingReplayEventsTotal.inc({ action: "missing" });
          continue;
        }

        if (!subscriptions.some((subscription) => topicMatches(subscription, record.topic))) {
          continue;
        }

        results.push(record);
        if (results.length >= this.maxReplayEventsValue) {
          break;
        }
      }
    }

    if (staleMembers.size > 0) {
      await this.redis.zrem(this.indexKey(), ...staleMembers);
      metrics.fepStreamingReplayEventsTotal.inc({ action: "pruned" });
    }

    return results;
  }

  private async readPersistedRecord(sequence: number): Promise<FepStoredReplayEvent | null> {
    const raw = await this.redis.get(this.eventKey(sequence));
    if (!raw) {
      return null;
    }

    try {
      return PersistedReplayEventSchema.parse(JSON.parse(raw));
    } catch (error) {
      logger.warn("FEP-3ab2 replay record parse failed", {
        sequence,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.redis.del(this.eventKey(sequence));
      return null;
    }
  }

  private sequenceKey(): string {
    return `${this.prefix}:replay:sequence`;
  }

  private indexKey(): string {
    return `${this.prefix}:replay:index`;
  }

  private eventKey(sequence: number): string {
    return `${this.prefix}:replay:event:${sequence}`;
  }
}

export function buildReplayEventId(sequence: number): string {
  return `${REPLAY_EVENT_ID_PREFIX}${sequence}`;
}

export function parseReplayEventId(eventId: string | undefined): number | null {
  if (!eventId || typeof eventId !== "string") {
    return null;
  }

  const normalized = eventId.trim();
  if (!normalized.startsWith(REPLAY_EVENT_ID_PREFIX)) {
    return null;
  }

  const sequence = Number.parseInt(normalized.slice(REPLAY_EVENT_ID_PREFIX.length), 10);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export function isReplayEventId(eventId: string | undefined): boolean {
  return parseReplayEventId(eventId) !== null;
}
