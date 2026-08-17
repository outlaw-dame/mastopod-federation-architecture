import { createClient } from "redis";
import { HttpControlledTargetFixtureClient } from "./ControlledTargetFixtureClient.js";
import {
  AdspRemoteFixtureDurableObserver,
  type AdspRemoteQueueObservationPort,
  type AdspRemoteRedisReadPort,
} from "./RemoteFixtureDurableObserver.js";
import { AdspRemoteFixtureHandoffClient } from "./RemoteFixtureHandoffClient.js";
import type { AdspRemoteFixtureRunInput, AdspRemoteFixtureRunResult } from "./RemoteFixtureRunner.js";
import { AdspRemoteFixtureRunner } from "./RemoteFixtureRunner.js";

export interface AdspRemoteLiveRuntimeConfig {
  redisUrl: string;
  sidecarWebhookUrl: string;
  sidecarToken: string;
  targetStatsUrl: string;
  consumerGroup: string;
  inboundStreamKey: string;
  outboundStreamKey: string;
  outboxIntentStreamKey: string;
  originReconcileStreamKey: string;
  outboundDlqStreamKey: string;
}

export interface RedisGroupInspectionPort {
  xInfoGroups(streamKey: string): Promise<Array<{ name: string }>>;
}

export interface RedisReadOnlyObservationPort extends RedisGroupInspectionPort, AdspRemoteRedisReadPort {
  xPending(streamKey: string, consumerGroup: string): Promise<{ pending?: number } | null>;
  xLen(streamKey: string): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

function exact(name: string, value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
}

function optionalNonNegativeSafeInteger(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${name} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

export function parseAdspRemoteLiveRuntimeConfig(
  env: Record<string, string | undefined>,
): AdspRemoteLiveRuntimeConfig {
  return {
    redisUrl: exact("ADSP_REMOTE_REDIS_URL", env["ADSP_REMOTE_REDIS_URL"]),
    sidecarWebhookUrl: exact(
      "ADSP_REMOTE_SIDECAR_WEBHOOK_URL",
      env["ADSP_REMOTE_SIDECAR_WEBHOOK_URL"],
    ),
    sidecarToken: exact("ADSP_REMOTE_SIDECAR_TOKEN", env["ADSP_REMOTE_SIDECAR_TOKEN"]),
    targetStatsUrl: exact(
      "ADSP_REMOTE_TARGET_STATS_URL",
      env["ADSP_REMOTE_TARGET_STATS_URL"],
    ),
    consumerGroup: exact(
      "ADSP_REMOTE_CONSUMER_GROUP",
      env["ADSP_REMOTE_CONSUMER_GROUP"],
    ),
    inboundStreamKey: exact(
      "ADSP_REMOTE_INBOUND_STREAM_KEY",
      env["ADSP_REMOTE_INBOUND_STREAM_KEY"],
    ),
    outboundStreamKey: exact(
      "ADSP_REMOTE_OUTBOUND_STREAM_KEY",
      env["ADSP_REMOTE_OUTBOUND_STREAM_KEY"],
    ),
    outboxIntentStreamKey: exact(
      "ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY",
      env["ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY"],
    ),
    originReconcileStreamKey: exact(
      "ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY",
      env["ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY"],
    ),
    outboundDlqStreamKey: exact(
      "ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY",
      env["ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY"],
    ),
  };
}

export async function assertExistingSidecarConsumerGroups(
  redis: RedisGroupInspectionPort,
  config: Pick<
    AdspRemoteLiveRuntimeConfig,
    | "consumerGroup"
    | "inboundStreamKey"
    | "outboundStreamKey"
    | "outboxIntentStreamKey"
    | "originReconcileStreamKey"
  >,
): Promise<void> {
  const streams = [
    ["inbound", config.inboundStreamKey],
    ["outbound", config.outboundStreamKey],
    ["outbox_intent", config.outboxIntentStreamKey],
    ["origin_reconcile", config.originReconcileStreamKey],
  ] as const;

  for (const [label, streamKey] of streams) {
    let groups: Array<{ name: string }>;
    try {
      groups = await redis.xInfoGroups(streamKey);
    } catch (error) {
      throw new Error(
        `ADSP live fixture requires existing ${label} stream/group before observation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!groups.some(group => group.name === config.consumerGroup)) {
      throw new Error(
        `ADSP live fixture requires consumer group ${config.consumerGroup} on ${label} stream ${streamKey}; refusing to create measurement topology`,
      );
    }
  }
}

/**
 * Read-only adapter for the exact Redis state consumed by ADSP reconciliation.
 * It intentionally exposes no XGROUP/XADD/HSET/DEL operations, so fixture
 * observation cannot create or repair production measurement topology.
 */
export class AdspRemoteReadOnlyQueueObservation implements AdspRemoteQueueObservationPort {
  constructor(
    private readonly redis: RedisReadOnlyObservationPort,
    private readonly config: Pick<
      AdspRemoteLiveRuntimeConfig,
      | "consumerGroup"
      | "outboundStreamKey"
      | "outboxIntentStreamKey"
      | "outboundDlqStreamKey"
    >,
  ) {}

  async getOutboxIntentState(intentId: string): Promise<{
    completedAt?: number;
    jobCount?: number;
  }> {
    const raw = await this.redis.hGetAll(`ap:outbox-intent:state:${intentId}`);
    const completedAt = optionalNonNegativeSafeInteger(
      "outbox intent completedAt",
      raw["completedAt"],
    );
    const jobCount = optionalNonNegativeSafeInteger(
      "outbox intent jobCount",
      raw["jobCount"],
    );
    return {
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(jobCount !== undefined ? { jobCount } : {}),
    };
  }

  async getPendingCount(type: "outbound" | "outbox_intent"): Promise<number> {
    const streamKey = type === "outbound"
      ? this.config.outboundStreamKey
      : this.config.outboxIntentStreamKey;
    const pending = await this.redis.xPending(streamKey, this.config.consumerGroup);
    const count = pending?.pending;
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new Error(`${type} pending count must be a non-negative safe integer`);
    }
    return Number(count);
  }

  async getDlqLength(type: "outbound"): Promise<number> {
    const length = await this.redis.xLen(this.config.outboundDlqStreamKey);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`${type} DLQ length must be a non-negative safe integer`);
    }
    return length;
  }
}

export async function runAdspRemoteLiveFixture(input: {
  config: AdspRemoteLiveRuntimeConfig;
  fixtureCase: AdspRemoteFixtureRunInput;
}): Promise<AdspRemoteFixtureRunResult> {
  const { config, fixtureCase } = input;
  const redis = createClient({ url: config.redisUrl });
  redis.on("error", () => undefined);

  try {
    await redis.connect();
    const readOnlyRedis = redis as unknown as RedisReadOnlyObservationPort;
    await assertExistingSidecarConsumerGroups(readOnlyRedis, config);

    const queue = new AdspRemoteReadOnlyQueueObservation(readOnlyRedis, config);
    const observer = new AdspRemoteFixtureDurableObserver(queue, readOnlyRedis);
    const handoff = new AdspRemoteFixtureHandoffClient(
      config.sidecarWebhookUrl,
      config.sidecarToken,
    );
    const target = new HttpControlledTargetFixtureClient(config.targetStatsUrl);
    const runner = new AdspRemoteFixtureRunner(handoff, observer, target);
    return await runner.run(fixtureCase);
  } finally {
    if (redis.isOpen) await redis.quit().catch(() => undefined);
  }
}
