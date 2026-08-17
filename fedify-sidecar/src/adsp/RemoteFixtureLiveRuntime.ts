import { createClient } from "redis";
import { RedisStreamsQueue as CoreRedisStreamsQueue } from "../queue/sidecar-redis-queue-core.js";
import { HttpControlledTargetFixtureClient } from "./ControlledTargetFixtureClient.js";
import { AdspRemoteFixtureDurableObserver } from "./RemoteFixtureDurableObserver.js";
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
}

export interface RedisGroupInspectionPort {
  xInfoGroups(streamKey: string): Promise<Array<{ name: string }>>;
}

function exact(name: string, value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty exact string`);
  }
  return value;
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

export async function runAdspRemoteLiveFixture(input: {
  config: AdspRemoteLiveRuntimeConfig;
  fixtureCase: AdspRemoteFixtureRunInput;
}): Promise<AdspRemoteFixtureRunResult> {
  const { config, fixtureCase } = input;
  const redis = createClient({ url: config.redisUrl });
  redis.on("error", () => undefined);
  let queue: CoreRedisStreamsQueue | null = null;

  try {
    await redis.connect();
    await assertExistingSidecarConsumerGroups(redis as unknown as RedisGroupInspectionPort, config);

    queue = new CoreRedisStreamsQueue({
      redisUrl: config.redisUrl,
      consumerGroup: config.consumerGroup,
      consumerId: `adsp-observer-${process.pid}`,
      inboundStreamKey: config.inboundStreamKey,
      outboundStreamKey: config.outboundStreamKey,
      outboxIntentStreamKey: config.outboxIntentStreamKey,
      originReconcileStreamKey: config.originReconcileStreamKey,
    });
    await queue.connect();

    const observer = new AdspRemoteFixtureDurableObserver(queue, redis);
    const handoff = new AdspRemoteFixtureHandoffClient(
      config.sidecarWebhookUrl,
      config.sidecarToken,
    );
    const target = new HttpControlledTargetFixtureClient(config.targetStatsUrl);
    const runner = new AdspRemoteFixtureRunner(handoff, observer, target);
    return await runner.run(fixtureCase);
  } finally {
    if (queue) await queue.disconnect().catch(() => undefined);
    if (redis.isOpen) await redis.quit().catch(() => undefined);
  }
}
