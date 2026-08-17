import { describe, expect, it, vi } from "vitest";
import {
  AdspRemoteReadOnlyQueueObservation,
  assertExistingSidecarConsumerGroups,
  parseAdspRemoteLiveRuntimeConfig,
  type RedisReadOnlyObservationPort,
} from "../RemoteFixtureLiveRuntime.js";

function env() {
  return {
    ADSP_REMOTE_REDIS_URL: "redis://127.0.0.1:6379/15",
    ADSP_REMOTE_SIDECAR_WEBHOOK_URL: "http://127.0.0.1:8080/webhook/outbox",
    ADSP_REMOTE_SIDECAR_TOKEN: "test-token-not-a-production-secret",
    ADSP_REMOTE_TARGET_STATS_URL: "http://127.0.0.1:18080/stats",
    ADSP_REMOTE_CONSUMER_GROUP: "sidecar-workers",
    ADSP_REMOTE_INBOUND_STREAM_KEY: "ap:queue:inbound:v1",
    ADSP_REMOTE_OUTBOUND_STREAM_KEY: "ap:queue:outbound:v1",
    ADSP_REMOTE_OUTBOX_INTENT_STREAM_KEY: "ap:queue:outbox-intent:v1",
    ADSP_REMOTE_ORIGIN_RECONCILE_STREAM_KEY: "ap:queue:origin-reconcile:v1",
    ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY: "ap:queue:dlq:outbound:v1",
  };
}

function readOnlyRedis(overrides: Partial<RedisReadOnlyObservationPort> = {}): RedisReadOnlyObservationPort {
  return {
    xInfoGroups: vi.fn().mockResolvedValue([{ name: "sidecar-workers" }]),
    xPending: vi.fn().mockResolvedValue({ pending: 0 }),
    xLen: vi.fn().mockResolvedValue(0),
    hGetAll: vi.fn().mockResolvedValue({}),
    exists: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe("ADSP remote live runtime configuration", () => {
  it("requires every topology coordinate explicitly, including the observed outbound DLQ", () => {
    expect(parseAdspRemoteLiveRuntimeConfig(env())).toEqual({
      redisUrl: "redis://127.0.0.1:6379/15",
      sidecarWebhookUrl: "http://127.0.0.1:8080/webhook/outbox",
      sidecarToken: "test-token-not-a-production-secret",
      targetStatsUrl: "http://127.0.0.1:18080/stats",
      consumerGroup: "sidecar-workers",
      inboundStreamKey: "ap:queue:inbound:v1",
      outboundStreamKey: "ap:queue:outbound:v1",
      outboxIntentStreamKey: "ap:queue:outbox-intent:v1",
      originReconcileStreamKey: "ap:queue:origin-reconcile:v1",
      outboundDlqStreamKey: "ap:queue:dlq:outbound:v1",
    });

    const missingGroup = env();
    delete (missingGroup as Partial<typeof missingGroup>).ADSP_REMOTE_CONSUMER_GROUP;
    expect(() => parseAdspRemoteLiveRuntimeConfig(missingGroup)).toThrow(/ADSP_REMOTE_CONSUMER_GROUP/u);

    const missingDlq = env();
    delete (missingDlq as Partial<typeof missingDlq>).ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY;
    expect(() => parseAdspRemoteLiveRuntimeConfig(missingDlq)).toThrow(/ADSP_REMOTE_OUTBOUND_DLQ_STREAM_KEY/u);
  });

  it("proves all expected consumer groups exist before observation", async () => {
    const inspector = {
      xInfoGroups: vi.fn().mockResolvedValue([{ name: "sidecar-workers" }]),
    };
    const config = parseAdspRemoteLiveRuntimeConfig(env());

    await expect(assertExistingSidecarConsumerGroups(inspector, config)).resolves.toBeUndefined();
    expect(inspector.xInfoGroups).toHaveBeenCalledTimes(4);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(1, config.inboundStreamKey);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(2, config.outboundStreamKey);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(3, config.outboxIntentStreamKey);
    expect(inspector.xInfoGroups).toHaveBeenNthCalledWith(4, config.originReconcileStreamKey);
  });

  it("refuses missing topology rather than creating or repairing it", async () => {
    const inspector = {
      xInfoGroups: vi.fn()
        .mockResolvedValueOnce([{ name: "sidecar-workers" }])
        .mockResolvedValueOnce([]),
    };
    const config = parseAdspRemoteLiveRuntimeConfig(env());

    await expect(assertExistingSidecarConsumerGroups(inspector, config))
      .rejects.toThrow(/refusing to create measurement topology/u);
  });

  it("fails closed when stream inspection itself cannot prove existing topology", async () => {
    const inspector = {
      xInfoGroups: vi.fn().mockRejectedValue(new Error("ERR no such key")),
    };
    const config = parseAdspRemoteLiveRuntimeConfig(env());

    await expect(assertExistingSidecarConsumerGroups(inspector, config))
      .rejects.toThrow(/requires existing inbound stream\/group/u);
  });
});

describe("AdspRemoteReadOnlyQueueObservation", () => {
  it("reads production pending/state/DLQ coordinates without any topology repair API", async () => {
    const redis = readOnlyRedis({
      xPending: vi.fn()
        .mockResolvedValueOnce({ pending: 2 })
        .mockResolvedValueOnce({ pending: 3 }),
      xLen: vi.fn().mockResolvedValue(4),
      hGetAll: vi.fn().mockResolvedValue({ completedAt: "123", jobCount: "1" }),
    });
    const config = parseAdspRemoteLiveRuntimeConfig(env());
    const observation = new AdspRemoteReadOnlyQueueObservation(redis, config);

    await expect(observation.getPendingCount("outbound")).resolves.toBe(2);
    await expect(observation.getPendingCount("outbox_intent")).resolves.toBe(3);
    await expect(observation.getDlqLength("outbound")).resolves.toBe(4);
    await expect(observation.getOutboxIntentState("intent-1")).resolves.toEqual({
      completedAt: 123,
      jobCount: 1,
    });

    expect(redis.xPending).toHaveBeenNthCalledWith(1, config.outboundStreamKey, config.consumerGroup);
    expect(redis.xPending).toHaveBeenNthCalledWith(2, config.outboxIntentStreamKey, config.consumerGroup);
    expect(redis.xLen).toHaveBeenCalledWith(config.outboundDlqStreamKey);
    expect(redis.hGetAll).toHaveBeenCalledWith("ap:outbox-intent:state:intent-1");
  });

  it("propagates NOGROUP instead of repairing topology after preflight", async () => {
    const redis = readOnlyRedis({
      xPending: vi.fn().mockRejectedValue(new Error("NOGROUP No such key or consumer group")),
    });
    const observation = new AdspRemoteReadOnlyQueueObservation(
      redis,
      parseAdspRemoteLiveRuntimeConfig(env()),
    );

    await expect(observation.getPendingCount("outbound")).rejects.toThrow(/NOGROUP/u);
  });

  it("fails closed on malformed durable state instead of treating NaN as completion", async () => {
    const redis = readOnlyRedis({
      hGetAll: vi.fn().mockResolvedValue({ completedAt: "12oops", jobCount: "1.0" }),
    });
    const observation = new AdspRemoteReadOnlyQueueObservation(
      redis,
      parseAdspRemoteLiveRuntimeConfig(env()),
    );

    await expect(observation.getOutboxIntentState("intent-1"))
      .rejects.toThrow(/canonical non-negative integer/u);
  });
});
